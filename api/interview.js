import { Groq } from "groq-sdk";

// Initialize the official Groq Client Engine
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// Hardcoded expert engineering interviewer personalities
const INTERVIEWERS = {
    rohan: { name: "Rohan Khanna", title: "Principal Systems Architect" },
    sarah: { name: "Sarah Jenkins", title: "Director of Engineering" }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed. Use POST pipeline." });
    }

    try {
        const { jobDescription, resume, chatHistory, interviewerId } = req.body;

        // Validation fallback gates
        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: "Missing required profile context parameters." });
        }

        // Select active interviewer character profile (defaulting to Rohan Khanna)
        const activeInterviewer = INTERVIEWERS[interviewerId] || INTERVIEWERS.rohan;

        // --- STAGE 1: ACCURATELY COUNT DELIVERED TECHNICAL QUESTIONS ---
        // We count ONLY the assistant messages that present an actual question mark.
        // We explicitly ignore the introduction greeting message so it doesn't steal from the quota.
        const totalTechnicalQuestionsAsked = chatHistory.filter(msg => 
            msg.role === "assistant" && 
            msg.content.includes("?") &&
            !msg.content.includes(activeInterviewer.title)
        ).length;

        // Check if a sudden-death time ceiling termination loop was triggered by the frontend clock
        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        
        // CRITICAL PACING LOCK: Force conclusion ONLY when 5 full technical questions have been delivered,
        // or if the frontend timer ran out completely.
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= 5 || isTimeCeilingReached;

        // --- STAGE 2: SYSTEM MANDATE PACKAGING ---
        const systemPrompt = `You are ${activeInterviewer.name}, a ${activeInterviewer.title} conducting a high-stakes engineering technical mock interview.

Target Role Requirements Context:
${jobDescription}

Candidate Resume Background Profile:
${resume}

YOUR MANDATE (STRICT PACING CONTROL):
- You must ask exactly 5 distinct, sharp technical questions total during this session.
- Current Count of Real Questions Asked So Far: ${totalTechnicalQuestionsAsked} / 5.
- If totalTechnicalQuestionsAsked is less than 5, you MUST ask your next technical question. Do not waste a turn on conversational transitions like "Let's move on to the next question" without including the actual technical question in that same message.
- Once the candidate answers your 5th technical question (meaning totalTechnicalQuestionsAsked equals 5), or if a timeout occurs, you MUST declare the interview officially over, switch the "isConcluded" JSON flag to true, refuse to generate a 6th question, and compile your full diagnostic scorecard report payload.

OUTPUT SPECIFICATIONS & DATA SCHEMA:
You must return a raw, clean JSON block matching this structural blueprint schema perfectly with NO markdown syntax wrapping blocks:
{
    "aiMessage": "Your next technical question. If concluding on question 5 or due to timeout, write a concise, direct closing wrap-up statement here.",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"}, 
    "score": ${forceSessionConclusion ? "An integer between 1 and 100 evaluating overall performance." : "0"},
    "verdict": "${forceSessionConclusion ? "Set to 'OFFER EXTENDED (PROVISIONAL)' if score >= 70, otherwise 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "A piercing, unvarnished, brutally honest peer-level evaluation analysis outlining the exact structural depth of their answers. Do not sugarcoat flaws." : "Active session live."}",
    "gapsToFix": ${forceSessionConclusion ? "A flat JSON array of strings listing specific engineering gaps, missing keywords, or structural holes spotted across their answers." : "[]"}
}

DYNAMIC CLOSURE EVALUATION MATRIX RULES:
If isConcluded is true, grade their performance strictly based on the technical precision and depth displayed across all their answers.`;

        // --- STAGE 3: EXECUTE GROQ COMPILATION PIPELINE ---
        const cleanPayloadArray = [
            { role: "system", content: systemPrompt },
            ...chatHistory
        ];

        const groqCompletionResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: cleanPayloadArray,
            temperature: 0.3, 
            max_tokens: 1200,
            response_format: { type: "json_object" } 
        });

        // Parse and extract the structured content response
        const rawJsonStringOutput = groqCompletionResponse.choices[0].message.content;
        const parsedReportObjectPayload = JSON.parse(rawJsonStringOutput);

        return res.status(200).json(parsedReportObjectPayload);

    } catch (error) {
        console.error("🚨 API ROUTE CRASH ERROR:", error);
        return res.status(500).json({ 
            error: "Internal server processing failure inside interview simulation compiler.", 
            details: error.message 
        });
    }
}
