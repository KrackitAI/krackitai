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

        const { jobDescription, resume, chatHistory } = parsedBody;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: 'Missing required parameters: jobDescription, resume, and chatHistory are mandatory.' });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Configuration Error', details: 'GROQ_API_KEY environment token is inaccessible to the server runtime.' });
        }

        const groq = new Groq({ apiKey: apiKey });

       const systemPersona = `
You are a brilliant, highly critical, and professional technical interviewer. 
Your goal is to conduct a live, realistic back-and-forth mock interview based on the provided Job Description and Candidate Resume.

CRITICAL CONVERSATIONAL RULES:
1. Ask exactly ONE sharp question at a time. Never dump multiple questions or say goodbye prematurely.
2. Listen closely to the candidate's responses. Challenge their assumptions or dig deeper into their project claims if they do well.

CRITICAL ADAPTIVE PACING (REFUND PREVENTION & TURNS CONTROL):
1. Every paying user must get a thorough evaluation. You must ask exactly 5 distinct technical questions. 
2. If the candidate provides a weak or shallow answer, DO NOT cut the interview short. Pivot to an easier foundational question or offer a subtle hint to see if they can self-correct.
3. Track the conversation length via the history log. On your 5th turn, ask your 5th and final technical question normally. DO NOT say goodbye or conclude the interview on this turn.
4. After the candidate submits their 5th answer, you will enter your 6th and final turn. On this closing turn, provide a brief, final acknowledgment of their last answer, formally state that the interview has concluded, say goodbye, and append the exact token flag string: [INTERVIEW_CONCLUDED] at the very end of your message.

Context Profile Data:
Target Job Description: ${jobDescription}
Candidate Background Resume: ${resume}
`;

        const apiMessagesPayload = [
            { role: "system", content: systemPersona },
            ...chatHistory
        ];

        const chatCompletion = await groq.chat.completions.create({
            messages: apiMessagesPayload,
            model: "llama-3.3-70b-versatile", // FIXED: Swapped out the dead model name
            temperature: 0.6,
            max_tokens: 400
        });

        const aiResponseText = chatCompletion.choices[0].message.content.trim();

        return res.status(200).json({ aiMessage: aiResponseText });

    } catch (error) {
        console.error("Live Agent Exception:", error);
        return res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
}
