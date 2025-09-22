import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function main(prompt) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const result = await model.generateContent(
    `Generate an appropriate email reply to the Last. Use the content provided: ${prompt}. Only give the actual body of the email response. `
  );

  return result.response.text();
}

app.post("/generate", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const replyText = await main(prompt);
    res.json({ text: replyText });
  } catch (err) {
    console.error("Error in /generate:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  }
});

app.listen(3000, () => {
  console.log("✅ Backend running on http://localhost:3000");
});
