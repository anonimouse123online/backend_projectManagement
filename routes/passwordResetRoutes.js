const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const router = express.Router();

const pool = require("../db");


// ============================================================
// TEMPORARY OTP STORAGE
// ============================================================
//
// email -> {
//     code: "123456",
//     expiresAt: timestamp,
//     verified: false
// }
//
// For testing/capstone use.
// NOTE: Codes disappear when backend restarts.
// ============================================================

const resetCodes = new Map();


// ============================================================
// EMAILJS OTP SENDER
// ============================================================

async function sendResetOtp(email, code) {

    console.log("\n======================================");
    console.log("📧 EMAILJS OTP SEND STARTED");
    console.log("TO:", email);

    console.log(
        "SERVICE ID:",
        process.env.EMAILJS_SERVICE_ID
            ? process.env.EMAILJS_SERVICE_ID
            : "MISSING"
    );

    const templateId =
        process.env.EMAILJS_PASSWORD_RESET_TEMPLATE_ID ||
        process.env.EMAILJS_TEMPLATE_ID;

    console.log(
        "TEMPLATE ID:",
        templateId
            ? templateId
            : "MISSING"
    );

    console.log(
        "PUBLIC KEY:",
        process.env.EMAILJS_PUBLIC_KEY
            ? "FOUND"
            : "MISSING"
    );

    console.log("======================================");


    // ========================================================
    // CHECK ENV VARIABLES
    // ========================================================

    if (
        !process.env.EMAILJS_SERVICE_ID ||
        !templateId ||
        !process.env.EMAILJS_PUBLIC_KEY
    ) {

        throw new Error(
            "EmailJS environment variables are missing."
        );
    }


    const emailPayload = {

        service_id:
            process.env.EMAILJS_SERVICE_ID,

        template_id:
            templateId,

        user_id:
            process.env.EMAILJS_PUBLIC_KEY,

        template_params: {

            // MUST match {{email}}
            email: email,

            // MUST match {{passcode}}
            passcode: code
        }
    };


    // Optional EmailJS private key
    if (
        process.env.EMAILJS_PRIVATE_KEY
    ) {

        emailPayload.accessToken =
            process.env.EMAILJS_PRIVATE_KEY;
    }


    try {

        console.log(
            "🌐 Sending request to EmailJS..."
        );


        const controller =
            new AbortController();


        const timeout =
            setTimeout(
                () => {

                    controller.abort();

                },
                15000
            );


        let response;

        try {

            response =
                await fetch(
                    "https://api.emailjs.com/api/v1.0/email/send",
                    {

                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        signal:
                            controller.signal,

                        body:
                            JSON.stringify(
                                emailPayload
                            )
                    }
                );

        } finally {

            clearTimeout(
                timeout
            );
        }


        const responseText =
            await response.text();


        console.log(
            "📨 EMAILJS HTTP STATUS:",
            response.status
        );

        console.log(
            "📨 EMAILJS RESPONSE:",
            responseText
        );


        if (
            !response.ok
        ) {

            throw new Error(
                `EmailJS failed (${response.status}): ${responseText}`
            );
        }


        console.log(
            "✅ OTP EMAIL SENT SUCCESSFULLY"
        );

        console.log(
            "======================================\n"
        );


        return true;


    } catch (error) {

        console.error(
            "\n❌ EMAILJS ERROR"
        );

        console.error(
            "NAME:",
            error?.name
        );

        console.error(
            "MESSAGE:",
            error?.message
        );

        console.error(
            "STACK:",
            error?.stack
        );


        if (
            error?.name ===
            "AbortError"
        ) {

            throw new Error(
                "EmailJS request timed out after 15 seconds."
            );
        }


        throw error;
    }
}


// ============================================================
// FORGOT PASSWORD
//
// POST /auth/forgot-password
// ============================================================

router.post(
    "/forgot-password",
    async (req, res) => {

        const startTime =
            Date.now();


        console.log("\n======================================");
        console.log("🔐 FORGOT PASSWORD REQUEST");
        console.log(
            "TIME:",
            new Date().toISOString()
        );
        console.log("======================================");


        try {

            const {
                email
            } = req.body;


            // ====================================================
            // VALIDATE EMAIL
            // ====================================================

            if (
                !email
            ) {

                console.log(
                    "❌ Email missing"
                );

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        message:
                            "Email is required."
                    });
            }


            const cleanEmail =
                email
                    .trim()
                    .toLowerCase();


            console.log(
                "📧 EMAIL:",
                cleanEmail
            );


            // ====================================================
            // CHECK USER
            // ====================================================

            console.log(
                "🔎 Checking user in database..."
            );


            const userResult =
                await pool.query(
                    `
                    SELECT id, email
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [
                        cleanEmail
                    ]
                );


            console.log(
                "DATABASE RESULT COUNT:",
                userResult.rows.length
            );


            if (
                userResult.rows.length === 0
            ) {

                console.log(
                    "❌ Account not found:",
                    cleanEmail
                );


                return res
                    .status(404)
                    .json({

                        success:
                            false,

                        message:
                            "Account not found."
                    });
            }


            console.log(
                "✅ USER FOUND:",
                userResult.rows[0].id
            );


            // ====================================================
            // GENERATE SECURE 6-DIGIT OTP
            // ====================================================

            const code =
                crypto
                    .randomInt(
                        100000,
                        1000000
                    )
                    .toString();


            const expiresAt =
                Date.now() +
                10 * 60 * 1000;


            resetCodes.set(
                cleanEmail,
                {
                    code:
                        code,

                    expiresAt:
                        expiresAt,

                    verified:
                        false
                }
            );


            console.log(
                "✅ Password reset code generated."
            );


            // ONLY SHOW OTP WHILE DEVELOPING
            if (
                process.env.NODE_ENV !==
                "production"
            ) {

                console.log(
                    "🧪 DEVELOPMENT OTP:",
                    code
                );
            }


            console.log(
                "⏰ OTP EXPIRES:",
                new Date(
                    expiresAt
                ).toISOString()
            );


            // ====================================================
            // SEND EMAIL USING EMAILJS
            // ====================================================

            console.log(
                "📤 Sending OTP using EmailJS..."
            );


            await sendResetOtp(
                cleanEmail,
                code
            );


            console.log(
                "✅ FORGOT PASSWORD COMPLETED"
            );

            console.log(
                "⏱️ REQUEST TIME:",
                Date.now() - startTime,
                "ms"
            );


            return res
                .status(200)
                .json({

                    success:
                        true,

                    message:
                        "A verification code has been sent to your email."
                });


        } catch (error) {

            console.error(
                "\n======================================"
            );

            console.error(
                "❌ FORGOT PASSWORD ERROR"
            );

            console.error(
                "NAME:",
                error?.name
            );

            console.error(
                "MESSAGE:",
                error?.message
            );

            console.error(
                "STACK:",
                error?.stack
            );

            console.error(
                "TIME:",
                Date.now() - startTime,
                "ms"
            );

            console.error(
                "======================================\n"
            );


            return res
                .status(500)
                .json({

                    success:
                        false,

                    message:
                        "Unable to send password reset code.",

                    error:
                        process.env.NODE_ENV !==
                        "production"
                            ? error?.message
                            : undefined
                });
        }
    }
);


// ============================================================
// VERIFY RESET CODE
//
// POST /auth/verify-reset-code
// ============================================================

router.post(
    "/verify-reset-code",
    async (req, res) => {

        console.log(
            "\n🔐 VERIFY RESET CODE REQUEST"
        );


        try {

            const {
                email,
                code
            } = req.body;


            if (
                !email ||
                !code
            ) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        message:
                            "Email and verification code are required."
                    });
            }


            const cleanEmail =
                email
                    .trim()
                    .toLowerCase();


            console.log(
                "📧 VERIFY EMAIL:",
                cleanEmail
            );


            const saved =
                resetCodes.get(
                    cleanEmail
                );


            if (
                !saved
            ) {

                console.log(
                    "❌ No reset request"
                );


                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        message:
                            "No password reset request was found."
                    });
            }


            // ====================================================
            // CHECK EXPIRATION
            // ====================================================

            if (
                Date.now() >
                saved.expiresAt
            ) {

                resetCodes.delete(
                    cleanEmail
                );


                console.log(
                    "❌ OTP expired"
                );


                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        message:
                            "Verification code has expired."
                    });
            }


            // ====================================================
            // CHECK CODE
            // ====================================================

            if (
                saved.code !==
                code.toString()
            ) {

                console.log(
                    "❌ Incorrect OTP"
                );


                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        message:
                            "Incorrect verification code."
                    });
            }


            // ====================================================
            // MARK VERIFIED
            // ====================================================

            saved.verified =
                true;


            resetCodes.set(
                cleanEmail,
                saved
            );


            console.log(
                "✅ OTP VERIFIED"
            );


            return res
                .status(200)
                .json({

                    success:
                        true,

                    message:
                        "Verification code is valid."
                });


        } catch (error) {

            console.error(
                "❌ VERIFY RESET CODE ERROR:",
                error
            );


            return res
                .status(500)
                .json({

                    success:
                        false,

                    message:
                        "Unable to verify reset code."
                });
        }
    }
);


// ============================================================
// RESET PASSWORD
//
// POST /auth/reset-password
// ============================================================

// ============================================================
// RESET PASSWORD
// POST /auth/reset-password
// ============================================================

router.post("/reset-password", async (req, res) => {

    console.log("\n======================================");
    console.log("🔐 RESET PASSWORD REQUEST");
    console.log("======================================");

    try {

        const {
            email,
            code,
            newPassword
        } = req.body;


        // ========================================================
        // VALIDATE
        // ========================================================

        if (
            !email ||
            !code ||
            !newPassword
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Email, verification code and new password are required."
            });
        }


        if (
            newPassword.length < 8
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Password must contain at least 8 characters."
            });
        }


        const cleanEmail =
            email
                .trim()
                .toLowerCase();


        console.log(
            "📧 RESET EMAIL:",
            cleanEmail
        );


        // ========================================================
        // CHECK OTP
        // ========================================================

        const saved =
            resetCodes.get(
                cleanEmail
            );


        if (!saved) {

            console.log(
                "❌ No reset request found"
            );

            return res.status(400).json({
                success: false,
                message:
                    "Password reset request was not found."
            });
        }


        // ========================================================
        // CHECK EXPIRATION
        // ========================================================

        if (
            Date.now() >
            saved.expiresAt
        ) {

            resetCodes.delete(
                cleanEmail
            );


            console.log(
                "❌ Reset code expired"
            );


            return res.status(400).json({
                success: false,
                message:
                    "Verification code has expired."
            });
        }


        // ========================================================
        // CHECK OTP
        // ========================================================

        if (
            saved.code !==
            code.toString()
        ) {

            console.log(
                "❌ Incorrect reset code"
            );


            return res.status(400).json({
                success: false,
                message:
                    "Incorrect verification code."
            });
        }


        // ========================================================
        // HASH NEW PASSWORD
        // ========================================================

        console.log(
            "🔐 Hashing new password..."
        );


        const passwordHash =
            await bcrypt.hash(
                newPassword,
                10
            );


        console.log(
            "✅ New password hashed"
        );


        // ========================================================
        // UPDATE DATABASE
        // ========================================================

        console.log(
            "💾 Updating password in database..."
        );


        const result =
            await pool.query(
                `
                UPDATE users
                SET password_hash = $1,
                    updated_at = NOW()
                WHERE LOWER(email) = LOWER($2)
                RETURNING id, email
                `,
                [
                    passwordHash,
                    cleanEmail
                ]
            );


        // ========================================================
        // USER NOT FOUND
        // ========================================================

        if (
            result.rows.length === 0
        ) {

            console.log(
                "❌ Account not found"
            );


            return res.status(404).json({
                success: false,
                message:
                    "Account not found."
            });
        }


        // ========================================================
        // SUCCESS
        // ========================================================

        console.log(
            "✅ PASSWORD UPDATED SUCCESSFULLY"
        );

        console.log(
            "📧 ACCOUNT:",
            result.rows[0].email
        );


        // OTP cannot be reused
        resetCodes.delete(
            cleanEmail
        );


        console.log(
            "🗑️ Reset OTP deleted"
        );


        console.log(
            "======================================\n"
        );


        return res.status(200).json({
            success: true,
            message:
                "Password successfully changed."
        });


    } catch (error) {

        console.error(
            "\n======================================"
        );

        console.error(
            "❌ RESET PASSWORD ERROR"
        );

        console.error(
            "NAME:",
            error?.name
        );

        console.error(
            "MESSAGE:",
            error?.message
        );

        console.error(
            "STACK:",
            error?.stack
        );

        console.error(
            "======================================\n"
        );


        return res.status(500).json({
            success: false,
            message:
                "Unable to reset password."
        });
    }
});


module.exports = router;