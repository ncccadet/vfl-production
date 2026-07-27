const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('Warning: GEMINI_API_KEY environment variable is not set. AI features will fail.');
}

const genAI = new GoogleGenerativeAI(apiKey);
const MODEL_NAME = 'gemini-3.1-flash-lite';

/**
 * Extract token usage from a Gemini response.
 * Returns { promptTokenCount, candidatesTokenCount } or zeroes if unavailable.
 */
function extractUsage(response) {
  const meta = response.usageMetadata || {};
  return {
    promptTokenCount: meta.promptTokenCount || 0,
    candidatesTokenCount: meta.candidatesTokenCount || 0,
  };
}

/**
 * Call Gemini to generate content with a single prompt.
 * @param {string} prompt - The user prompt.
 * @param {Object} options - Configuration options.
 * @param {boolean} options.isJson - Whether the output should be constrained to JSON.
 * @param {string} [options.systemInstruction] - Optional system instruction to guide the model.
 * @returns {Promise<{text: string, usage: {promptTokenCount: number, candidatesTokenCount: number}}>}
 */
async function callGemini(prompt, options = {}) {
  const modelOptions = { model: MODEL_NAME };
  
  if (options.systemInstruction) {
    modelOptions.systemInstruction = options.systemInstruction;
  }
  
  const model = genAI.getGenerativeModel(modelOptions);
  
  const generationConfig = {};
  if (options.isJson) {
    generationConfig.responseMimeType = "application/json";
  }

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig
  });
  
  return {
    text: result.response.text(),
    usage: extractUsage(result.response),
  };
}

/**
 * Call Gemini with a chat history.
 * @param {Array<{role: string, parts: Array<{text: string}>}>} history - The chat history.
 * @param {string} newPrompt - The next message from the user.
 * @param {Object} options - Configuration options.
 * @param {string} [options.systemInstruction] - Optional system instruction.
 * @returns {Promise<{text: string, usage: {promptTokenCount: number, candidatesTokenCount: number}}>}
 */
async function callGeminiChat(history, newPrompt, options = {}) {
  const modelOptions = { model: MODEL_NAME };
  
  if (options.systemInstruction) {
    modelOptions.systemInstruction = options.systemInstruction;
  }
  
  const model = genAI.getGenerativeModel(modelOptions);
  
  const chat = model.startChat({
    history: history,
  });

  const result = await chat.sendMessage(newPrompt);
  return {
    text: result.response.text(),
    usage: extractUsage(result.response),
  };
}

module.exports = {
  callGemini,
  callGeminiChat
};
