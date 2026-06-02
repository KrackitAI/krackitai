import Groq from "groq-sdk";

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        let parsedBody = req.body;
        if (typeof parsedBody === 'string') {
            parsedBody = JSON.parse(parsedBody);
        }

        // We now accept a continuous chat history array from the frontend
        const { jobDescription, resume, chatHistory } = parsedBody;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: 'Missing required parameters: jobDescription, resume, and chatHistory are mandatory.' });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Configuration Error', details: 'GROQ_API_KEY is missing.' });
        }

        const groq = new Groq({ apiKey: apiKey });

        // System instructions detailing the live agent persona
        const systemPersona = `
You are a brilliant, highly critical, and brutally honest professional technical interviewer. 
Your goal is to conduct a live, realistic back-and-forth mock interview based on the provided Job Description and Candidate Resume.

CRITICAL RULES:
1. Ask exactly ONE question at a time. Never dump multiple questions at once.
2. Listen to the candidate's responses. Acknowledge, critique, or dig deeper into their previous answer if necessary, then transition naturally to your next question.
3. Keep your questions and responses concise, sharp, and highly relevant—ideal for a real-time voice conversation.
4. Do not include meta-text, markdown bold text, or conversational commentary like "Let's move on to Question 2." Speak directly as the interviewer.

Context Profile Data:
Target Job Description: ${jobDescription}
Candidate Background Resume: ${resume}
`;

        // Format the message loop using standard LLM chat payload arrays
        const apiMessagesPayload = [
            { role: "system", content: systemPersona },
            ...chatHistory // Injects the rolling thread of previous questions and answers directly
        ];

        const chatCompletion = await groq.chat.completions.create({
            messages: apiMessagesPayload,
            model: "llama-3.3-70b-specdec",
            temperature: 0.6, // Slightly higher temperature makes it sound more fluid and conversational
            max_tokens: 400
        });

        const aiResponseText = chatCompletion.choices[0].message.content.trim();

        // Return a clean, stable JSON object with just the text string response
        return res.status(200).json({ aiMessage: aiResponseText });

    } catch (error) {
        console.error("Live Agent Exception:", error);
        return res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
}
