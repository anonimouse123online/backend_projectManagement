/**
 * Sends a 6-digit registration verification code via EmailJS REST API.
 * Uses template: EMAILJS_SIGNUP_TEMPLATE_ID (default: template_tpsbz1q)
 * 
 * Target Endpoint: POST https://api.emailjs.com/api/v1.0/email/send
 * 
 * @param {string} email Target recipient email address
 * @param {string} code 6-digit verification code (OTP)
 * @returns {Promise<boolean>} True if email sent successfully
 */
async function sendVerificationCodeEmail(email, code) {
  console.log(`[EmailJS] Dispatching signup verification email request to: ${email}`);

  const templateId = process.env.EMAILJS_SIGNUP_TEMPLATE_ID || 'template_tpsbz1q';

  // Check required EmailJS environment variables
  if (
    !process.env.EMAILJS_SERVICE_ID ||
    !templateId ||
    !process.env.EMAILJS_PUBLIC_KEY
  ) {
    console.error("❌ EmailJS configuration error: Missing EMAILJS_SERVICE_ID, EMAILJS_SIGNUP_TEMPLATE_ID, or EMAILJS_PUBLIC_KEY in environment variables.");
    throw new Error("Email service is not properly configured on server.");
  }

  const emailPayload = {
    service_id: process.env.EMAILJS_SERVICE_ID,
    template_id: templateId,
    user_id: process.env.EMAILJS_PUBLIC_KEY,
    template_params: {
      email: email,
      passcode: code,
    },
  };

  // Include private key (accessToken) if configured in .env for backend authentication
  if (process.env.EMAILJS_PRIVATE_KEY) {
    emailPayload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
  }

  try {
    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`❌ EmailJS API failure (HTTP ${response.status}): ${responseText}`);
      throw new Error(`EmailJS sending failed with status ${response.status}`);
    }

    console.log(`✅ EmailJS signup verification email sent successfully to ${email}.`);
    return true;
  } catch (error) {
    console.error(`❌ EmailJS request error sending to ${email}:`, error.message);
    throw error;
  }
}

/**
 * Sends a 6-digit password reset code via EmailJS REST API.
 * Uses template: EMAILJS_PASSWORD_RESET_TEMPLATE_ID (default: template_piqozms)
 * 
 * @param {string} email Target recipient email address
 * @param {string} otp 6-digit password reset OTP
 * @returns {Promise<boolean>}
 */
async function sendResetOtp(email, otp) {
  console.log(`[EmailJS] Dispatching password reset email request to: ${email}`);

  const templateId = process.env.EMAILJS_PASSWORD_RESET_TEMPLATE_ID || process.env.EMAILJS_TEMPLATE_ID || 'template_piqozms';

  if (
    !process.env.EMAILJS_SERVICE_ID ||
    !templateId ||
    !process.env.EMAILJS_PUBLIC_KEY
  ) {
    console.error("❌ EmailJS configuration error: Missing EMAILJS_SERVICE_ID, EMAILJS_PASSWORD_RESET_TEMPLATE_ID, or EMAILJS_PUBLIC_KEY in environment variables.");
    throw new Error("Email service is not properly configured on server.");
  }

  const emailPayload = {
    service_id: process.env.EMAILJS_SERVICE_ID,
    template_id: templateId,
    user_id: process.env.EMAILJS_PUBLIC_KEY,
    template_params: {
      email: email,
      passcode: otp,
    },
  };

  if (process.env.EMAILJS_PRIVATE_KEY) {
    emailPayload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
  }

  try {
    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`❌ EmailJS API failure (HTTP ${response.status}): ${responseText}`);
      throw new Error(`EmailJS sending failed with status ${response.status}`);
    }

    console.log(`✅ EmailJS password reset email sent successfully to ${email}.`);
    return true;
  } catch (error) {
    console.error(`❌ EmailJS request error sending to ${email}:`, error.message);
    throw error;
  }
}

module.exports = {
  sendVerificationCodeEmail,
  sendResetOtp,
};