import io
import os
import base64
import logging
from typing import List

import torch
from PIL import Image
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.responses import FileResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModelForCausalLM

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Construction Site AI Report Service")

# ─── Reports directory ────────────────────────────────────────────────────────
REPORTS_DIR = "reports"
os.makedirs(REPORTS_DIR, exist_ok=True)

# ─── Validation Error Handler ─────────────────────────────────────────────────
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = [{k: str(v) for k, v in err.items()} for err in exc.errors()]
    logger.error(f"422 Validation Error: {errors}")
    return JSONResponse(status_code=422, content={"detail": errors})

# ─── Device ───────────────────────────────────────────────────────────────────
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
logger.info(f"Using device: {DEVICE}")

# ─── Load Moondream2 locally via transformers ─────────────────────────────────
logger.info("Loading Moondream2 from ./moondream2...")
moondream_tokenizer = AutoTokenizer.from_pretrained(
    "./moondream2",
    trust_remote_code=True,
    local_files_only=True,
)
moondream_model = AutoModelForCausalLM.from_pretrained(
    "./moondream2",
    trust_remote_code=True,
    torch_dtype=torch.float32,  # Keep float32 for Moondream — safer for custom model code
    local_files_only=True,
)
moondream_model.eval()
logger.info("Moondream2 ready.")

# ─── Load Qwen2.5-1.5B-Instruct ──────────────────────────────────────────────
QWEN_MODEL_ID = "Qwen/Qwen2.5-1.5B-Instruct"
logger.info(f"Loading {QWEN_MODEL_ID}...")
qwen_tokenizer = AutoTokenizer.from_pretrained(QWEN_MODEL_ID)
qwen_model = AutoModelForCausalLM.from_pretrained(
    QWEN_MODEL_ID,
    torch_dtype=torch.float32,  # float32 on CPU — float16 does NOT help on CPU
    device_map=None,
)
qwen_model = qwen_model.to(DEVICE)
qwen_model.eval()
logger.info("Qwen2.5-1.5B-Instruct ready.")


# ─── Request schemas ──────────────────────────────────────────────────────────
class ReportRequest(BaseModel):
    task_id:     str
    task_name:   str
    location:    str
    assigned_to: str
    date:        str
    images:      List[str]

class PDFUploadRequest(BaseModel):
    pdf_base64: str
    filename:   str


# ─── Moondream: ONE combined question ─────────────────────────────────────────
# OPTIMIZATION: Kept as one question (already good).
# Shortened slightly to reduce tokens Moondream needs to process.
SINGLE_QUESTION = (
    "Describe this construction site clearly. If unsure, make a reasonable estimate. Do not say 'unknown' or 'undefined'. "
    "1) work being done and completion %, "
    "2) number of workers and their activity, "
    "3) materials/equipment visible, "
    "4) any safety concerns or PPE violations."
)

def analyze_image(pil_image: Image.Image) -> str:
    """
    OPTIMIZATION: Now returns a single string instead of a redundant dict
    (the old code stored the same answer 4 times but only ever used one of them).
    """
    try:
        logger.info(f"     Image mode: {pil_image.mode}, size: {pil_image.size}")
        enc = moondream_model.encode_image(pil_image)

        answer = moondream_model.answer_question(
            enc,
            SINGLE_QUESTION,
            moondream_tokenizer,
        )
        answer = answer.strip()
        logger.info(f"    ✅ analysis: {answer[:120]}")
        return answer

    except Exception as e:
        logger.error(f"  ❌ analyze_image failed: {e}", exc_info=True)
        return "Could not analyze image."


# ─── Qwen: Generate report ────────────────────────────────────────────────────
def generate_report(
    task_name:        str,
    location:         str,
    assigned_to:      str,
    report_date:      str,
    all_observations: List[str],   # OPTIMIZATION: now List[str] not List[dict]
) -> str:
    obs_text = ""
    for i, obs in enumerate(all_observations, 1):
        obs_text += f"\n--- Image {i} ---\n{obs}\n"

    # OPTIMIZATION: Merged system + user into one leaner user message.
    # Duplicate instructions (role described twice) removed — saves input tokens.
    prompt = (
        f"Write a concise daily construction site report.\n\n"
        f"Task: {task_name}\n"
        f"Location: {location}\n"
        f"Assigned To: {assigned_to}\n"
        f"Date: {report_date}\n\n"
        f"Site observations from {len(all_observations)} photo(s):\n{obs_text}\n"
        f"Sections: 1. Work Done  2. Workers  3. Materials & Equipment  "
        f"4. Safety  5. Recommendations\n"
        f"Be factual and concise."
    )

    messages = [
        {"role": "system", "content": "You are a professional construction site report writer."},
        {"role": "user",   "content": prompt},
    ]

    text   = qwen_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = qwen_tokenizer([text], return_tensors="pt").to(DEVICE)

    with torch.no_grad():
        output_ids = qwen_model.generate(
            **inputs,
            max_new_tokens=512,        # Increased from 200 — prevents reports from being cut off
            do_sample=False,           # greedy decoding — faster + deterministic
            pad_token_id=qwen_tokenizer.eos_token_id,
        )

    generated = output_ids[0][inputs["input_ids"].shape[1]:]
    return qwen_tokenizer.decode(generated, skip_special_tokens=True).strip()


# ─── PDF Upload endpoint ──────────────────────────────────────────────────────
@app.post("/report/upload-pdf")
async def upload_report_pdf(payload: PDFUploadRequest):
    try:
        pdf_bytes = base64.b64decode(payload.pdf_base64)
        safe_filename = "".join(
            c for c in payload.filename if c.isalnum() or c in ("_", "-", ".")
        )
        if not safe_filename.endswith(".pdf"):
            safe_filename += ".pdf"

        filepath = os.path.join(REPORTS_DIR, safe_filename)
        with open(filepath, "wb") as f:
            f.write(pdf_bytes)

        logger.info(f"✅ PDF saved: {safe_filename} ({len(pdf_bytes)} bytes)")
        return JSONResponse({
            "success": True,
            "download_page": f"/report/download/{safe_filename}",
        })
    except Exception as e:
        logger.error(f"❌ PDF upload failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save PDF.")


# ─── Download page ────────────────────────────────────────────────────────────
@app.get("/report/download/{filename}", response_class=HTMLResponse)
async def report_download_page(request: Request, filename: str):
    filepath = os.path.join(REPORTS_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Report not found.")

    file_size_kb = round(os.path.getsize(filepath) / 1024, 1)
    base = str(request.base_url).rstrip("/")
    download_url = f"{base}/report/file/{filename}"

    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Download Report</title>
  <style>
    * {{ margin:0; padding:0; box-sizing:border-box; }}
    body {{
      font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
      background: #0B1120;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }}
    .card {{
      background: white;
      border-radius: 20px;
      padding: 36px 28px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }}
    .pdf-icon {{
      width: 80px; height: 80px;
      background: linear-gradient(135deg, #EF4444, #DC2626);
      border-radius: 20px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px;
      font-size: 40px;
    }}
    h1 {{ font-size: 20px; font-weight: 800; color: #0F172A; margin-bottom: 6px; }}
    .subtitle {{ font-size: 13px; color: #94A3B8; margin-bottom: 20px; }}
    .file-info {{
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 24px;
      text-align: left;
    }}
    .file-name {{ font-size: 13px; font-weight: 700; color: #0F172A; margin-bottom: 4px; word-break: break-all; }}
    .file-size {{ font-size: 12px; color: #94A3B8; }}
    .download-btn {{
      display: block;
      background: linear-gradient(135deg, #4F46E5, #7C3AED);
      color: white;
      text-decoration: none;
      font-size: 17px; font-weight: 700;
      padding: 18px;
      border-radius: 14px;
      margin-bottom: 12px;
      letter-spacing: 0.3px;
    }}
    .download-btn:active {{ opacity: 0.85; }}
    .hint {{ font-size: 12px; color: #94A3B8; line-height: 1.6; margin-top: 16px; }}
    .footer {{
      font-size: 11px; color: #CBD5E1;
      margin-top: 28px; padding-top: 16px;
      border-top: 1px solid #F1F5F9;
    }}
  </style>
</head>
<body>
  <div class="card">
    <div class="pdf-icon">📄</div>
    <h1>Daily Site Progress Report</h1>
    <p class="subtitle">AI-Generated · SitePulse</p>
    <div class="file-info">
      <div class="file-name">📎 {filename}</div>
      <div class="file-size">{file_size_kb} KB · PDF Document</div>
    </div>
    <a class="download-btn" href="{download_url}" download="{filename}">
      ⬇️&nbsp; Download PDF
    </a>
    <p class="hint">Tap the button above to download the report to your phone's Downloads folder.</p>
    <div class="footer">Generated by SitePulse AI · Powered by Moondream2 + Qwen2.5</div>
  </div>
</body>
</html>"""
    return HTMLResponse(content=html)


# ─── Serve the actual PDF file ────────────────────────────────────────────────
@app.get("/report/file/{filename}")
async def serve_report_file(filename: str):
    safe_filename = os.path.basename(filename)
    filepath = os.path.join(REPORTS_DIR, safe_filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(
        path=filepath,
        media_type="application/pdf",
        filename=safe_filename,
        headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
    )


# ─── Main generate-report endpoint ───────────────────────────────────────────
@app.post("/generate-report")
async def generate_report_endpoint(payload: ReportRequest):
    if not payload.images:
        raise HTTPException(status_code=400, detail="No images provided.")

    images_to_process = payload.images[:3]
    if len(payload.images) > 3:
        logger.warning(f"  ⚠️  {len(payload.images)} images received — processing only first 3")

    logger.info("═══════════════════════════════════════")
    logger.info(f"📥 task_id={payload.task_id} | task={payload.task_name} | images={len(images_to_process)}")
    logger.info("═══════════════════════════════════════")

    all_observations: List[str] = []   # OPTIMIZATION: plain strings now
    failed_count = 0

    for i, b64_string in enumerate(images_to_process):
        logger.info(f"  📸 Processing image {i+1}/{len(images_to_process)}...")
        try:
            img_bytes = base64.b64decode(b64_string)
            pil_image = Image.open(io.BytesIO(img_bytes)).convert("RGB")

            if max(pil_image.size) > 384:
                pil_image.thumbnail((384, 384), Image.LANCZOS)

            obs = analyze_image(pil_image)
            all_observations.append(obs)

            if "Could not analyze" in obs:
                failed_count += 1
                logger.warning(f"  ⚠️  Image {i+1} — analysis fallback")
            else:
                logger.info(f"  ✅ Image {i+1} done")

        except Exception as e:
            failed_count += 1
            logger.error(f"  ❌ Image {i+1} failed: {e}", exc_info=True)
            all_observations.append("Could not analyze image.")

    logger.info(f"📊 {len(all_observations) - failed_count}/{len(all_observations)} succeeded")
    logger.info("Generating report with Qwen2.5-1.5B...")

    report_text = generate_report(
        task_name        = payload.task_name,
        location         = payload.location,
        assigned_to      = payload.assigned_to,
        report_date      = payload.date,
        all_observations = all_observations,
    )
    logger.info(f"✅ Report generated ({len(report_text)} chars)")

    # OPTIMIZATION: observations in response are now plain strings (not dicts)
    return JSONResponse({
        "success":         True,
        "task_id":         payload.task_id,
        "report":          report_text,
        "observations":    all_observations,
        "images_analyzed": len(all_observations),
        "images_failed":   failed_count,
    })


# ─── Health Check ─────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "device": DEVICE}


# ─── Run ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        h11_max_incomplete_event_size=52428800,
    )