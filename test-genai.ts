import { GoogleGenAI, Modality } from "@google/genai";

console.log("Environment variables:", Object.keys(process.env));
console.log("API_KEY exists:", !!process.env.API_KEY);
console.log("GEMINI_API_KEY exists:", !!process.env.GEMINI_API_KEY);

const apiKey = process.env.API_KEY || "test";
const ai = new GoogleGenAI({ apiKey });

console.log("ai.models exists:", !!ai.models);
if (ai.models) {
    console.log("ai.models.generateVideos type:", typeof ai.models.generateVideos);
    console.log("ai.models.generateContent type:", typeof ai.models.generateContent);
}
console.log("ai.operations exists:", !!ai.operations);
if (ai.operations) {
    console.log("ai.operations.getVideosOperation type:", typeof ai.operations.getVideosOperation);
}
console.log("Modality.AUDIO:", Modality.AUDIO);
