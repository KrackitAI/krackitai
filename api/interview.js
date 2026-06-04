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
            return res.status(400).json({ error: 'Missing required parameters.' });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Configuration Error' });
        }

        const groq = new Groq({ apiKey: apiKey });

        const systemPersona = `
You are an expert, highly critical, and professional technical interviewer. Your goal is to conduct a live, realistic back-and-forth mock interview based on the provided Job Description and Candidate Resume.

CONVERSATIONAL RULES:
1. Ask exactly ONE sharp question at a time. Never dump multiple questions.
2. Listen closely to the candidate's responses. Challenge their assumptions, press them on shallow technical answers, or offer a brief hint if they completely stall out.
3. Keep the interview going naturally for as long as you feel is necessary to truly evaluate their depth. Do not count turns or announce question numbers.

HOW TO END THE INTERVIEW (DYNAMIC CLOSING):
When you feel you have gathered enough concrete data to confidently grade this candidate's profile, or if they are failing completely and cannot clear basic entry thresholds, you must decisively end the interview.

To end the interview, you must immediately shift your response format and return a strictly valid JSON object structured exactly like this:
{
  "isConcluded": true,
  "aiMessage": "Your final spoken goodbye message to the candidate out loud (e.g., 'Alright, that gives me a clear picture of your technical background. We are done here. Goodbye.')",
  "score": 45, 
  "verdict": "REJECTED / STRONG REJECT / PASS / STRONG PASS",
  "brutallyHonestReview": "A deeply detailed, critical, and completely unvarnished assessment of their performance. Point out exactly where their technical knowledge failed, where they sounded shallow, and what specific engineering concepts they got wrong.",
  "gapsToFix": ["Concept 1", "Concept 2", "Concept 3"]
}

For normal ongoing interview turns, simply reply with a normal plain text message containing your next interview question. Do not include JSON structures until you are completely ready to end the interview.

Context Profile Data:
Target Job Description: ${jobDescription}
Candidate Background Resume: ${resume}
`;

        const apiMessagesPayload = [
            { role: "system", content: systemPersona },
            ...chatHistory
        ];

        // We use a high-quality versatile model that can handle changing from text to JSON dynamically
        const chatCompletion = await groq.chat.completions.create({
            messages: apiMessagesPayload,
            model: "llama-3.1-8b-instant",
            temperature: 0.5,
            max_tokens: 1000
        });

        const rawResponseContent = chatCompletion.choices[0].message.content.trim();

        // Dynamically detect if the AI decided to output the final evaluation JSON payload
        if (rawResponseContent.startsWith('{') && rawResponseContent.endsWith('}')) {
            const parsedEvaluationData = JSON.parse(rawResponseContent);
            return res.status(200).json(parsedEvaluationData);
        } else {
            // Return standard text question back to the running interface
            return res.status(200).json({ aiMessage: rawResponseContent, isConcluded: false });
        }

    } catch (error) {
        console.error("Live Agent Exception:", error);
        return res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
}
