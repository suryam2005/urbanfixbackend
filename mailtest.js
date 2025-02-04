const axios = require("axios");

const sendEmail = async () => {
  try {
    const response = await axios.post(
      "https://api.mailersend.com/v1/email",
      {
        from: {
          email: "urbanfix10@gmail.com"
        },
        to: [
          {
            email: "mailsurya991@gmail.com"
          }
        ],
        subject: "Test Email from UrbanFix",
        text: "This is a test email sent via MailerSend API.",
        html: "<p>This is a test email sent via <strong>MailerSend API</strong>.</p>"
      },
      {
        headers: {
          "Authorization": `Bearer mlsn.4986361c00aa7732b1f8be02d77424af7d4e442cc61937027674e55da19c4e33`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Email sent:", response.data);
  } catch (error) {
    console.error("Error sending email:", error.response.data);
  }
};

// Call the function to send an email
sendEmail();