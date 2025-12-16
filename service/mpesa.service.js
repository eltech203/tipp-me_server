const request = require("request");

const baseURL = "https://sandbox.safaricom.co.ke";

/**
 * 🔑 GET ACCESS TOKEN
 */
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    request(
      {
        method: "GET",
        url: `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
        headers: {
          Authorization: `Basic ${auth}`,
        },
      },
      (err, response, body) => {
        if (err) return reject(err);

        const data = JSON.parse(body);
        resolve(data.access_token);
      }
    );
  });
}


/**
 * 🔑 GET ACCESS TOKEN
 */
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    request(
      {
        method: "GET",
        url: `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
        headers: {
          Authorization: `Basic ${auth}`,
        },
      },
      (err, response, body) => {
        if (err) return reject(err);

        const data = JSON.parse(body);
        resolve(data.access_token);
      }
    );
  });
}


function sendStk(phone, amount, reference) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();

      const timestamp = new Date()
        .toISOString()
        .replace(/[^0-9]/g, "")
        .slice(0, -3);

      const password = Buffer.from(
        `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
      ).toString("base64");

      request(
        {
          method: "POST",
          url: `${baseURL}/mpesa/stkpush/v1/processrequest`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
          json: {
            BusinessShortCode: process.env.MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: amount,
            PartyA: phone,
            PartyB: process.env.MPESA_SHORTCODE,
            PhoneNumber: phone,
            CallBackURL: 'https://tipp-meserver-production.up.railway.app/api/payments/callback/',
            AccountReference: reference,
            TransactionDesc: "Support / Tip",
          },
        },
        (err, response, body) => {
          if (err) return reject(err);
          console.log("STK Response:", body);
          resolve(body);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}


function sendB2C(phone, amount, remarks = "Withdrawal") {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();

      request(
        {
          method: "POST",
          url: `${baseURL}/mpesa/b2c/v1/paymentrequest`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
          json: {
            InitiatorName: "apiuser",
            SecurityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL,
            CommandID: "BusinessPayment",
            Amount: amount,
            PartyA: process.env.MPESA_B2C_SHORTCODE,
            PartyB: phone,
            Remarks: remarks,
            QueueTimeOutURL:
              process.env.MPESA_CALLBACK_URL + "/b2c-timeout",
            ResultURL:
              process.env.MPESA_CALLBACK_URL + "/b2c-result",
            Occasion: "Withdrawal",
          },
        },
        (err, response, body) => {
          if (err) return reject(err);
          resolve(body);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}
module.exports = {
  getAccessToken,
  sendStk,
  sendB2C,
};
