async function sendResetOtp(email, otp) {

    console.log("======================================");
    console.log("📧 SENDING OTP THROUGH EMAILJS");
    console.log("EMAIL:", email);

    console.log(
        "SERVICE ID:",
        process.env.EMAILJS_SERVICE_ID
            ? "FOUND"
            : "MISSING"
    );

    console.log(
        "TEMPLATE ID:",
        process.env.EMAILJS_TEMPLATE_ID
            ? "FOUND"
            : "MISSING"
    );

    console.log(
        "PUBLIC KEY:",
        process.env.EMAILJS_PUBLIC_KEY
            ? "FOUND"
            : "MISSING"
    );

    console.log("======================================");

    try {

        const response = await fetch(
            "https://api.emailjs.com/api/v1.0/email/send",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({

                    service_id:
                        process.env.EMAILJS_SERVICE_ID,

                    template_id:
                        process.env.EMAILJS_TEMPLATE_ID,

                    user_id:
                        process.env.EMAILJS_PUBLIC_KEY,

                    template_params: {

                        email: email,

                        passcode: otp
                    }
                })
            }
        );


        const responseText =
            await response.text();


        console.log(
            "EMAILJS STATUS:",
            response.status
        );

        console.log(
            "EMAILJS RESPONSE:",
            responseText
        );


        if (!response.ok) {

            throw new Error(
                `EmailJS failed (${response.status}): ${responseText}`
            );
        }


        console.log(
            "✅ OTP EMAIL SENT SUCCESSFULLY"
        );


        return true;


    } catch (error) {

        console.error(
            "❌ EMAILJS SEND ERROR:"
        );

        console.error(
            error
        );

        throw error;
    }
}