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

        // --- STAGE 1: FILTER RUNTIME SYSTEM INJECTIONS ---
        // Count how many legitimate technical answers the candidate has submitted so far.
        // We filter out background processing instructions like HINT requests or TIMEOUT signals.
        const ongoingTurnsCount = chatHistory.filter(msg => 
            msg.role === "user" && 
            !msg.content.includes("SYSTEM NOTE:")
        ).length;

        // Check if a sudden-death time ceiling termination loop was triggered by the frontend clock
        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        
        // Hard evaluation switch: Force conclusion if turn 5 is reached OR if they ran completely out of time
        const forceSessionConclusion = ongoingTurnsCount >= 5 || isTimeCeilingReached;

        // --- STAGE 2: SYSTEM MANDATE PACKAGING ---
        const systemPrompt = `You are ${activeInterviewer.name}, a ${activeInterviewer.title} conducting a high-stakes engineering technical mock interview.

Target Role Requirements Context:
${jobDescription}

Candidate Resume Background Profile:
${resume}

YOUR MANDATE (STRICT TURN-BASED PACING CONTROL):
- This is a high-speed 5-Question Sprint Interview designed for free-tier sandbox validation evaluation loops.
- You will ask exactly 5 distinct, sharp technical questions total. Do not drag the session out forever.
- Current Conversational Turn Progress: ${ongoingTurnsCount} / 5.
- Once the candidate answers your 5th question (Current Progress reaches 5), or if a timeout occurs, you MUST declare the interview officially over, switch the "isConcluded" JSON flag boolean property to true, refuse to generate a 6th question, and compile your full diagnostic scorecard analytics report payload.

OUTPUT SPECIFICATIONS & DATA SCHEMA:
You must return a raw, clean JSON block matching this structural blueprint schema perfectly with NO markdown syntax wrapping wrapper blocks:
{
    "aiMessage": "Your next sharp technical follow-up question. If concluding on turn 5 or due to timeout, write a concise, direct closing wrap-up sign-off statement here.",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"}, 
    "score": ${forceSessionConclusion ? "An integer between 1 and 100 evaluating overall performance." : "0"},
    "verdict": "${forceSessionConclusion ? "Set to 'OFFER EXTENDED (PROVISIONAL)' if score >= 70, otherwise 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "A piercing, unvarnished, brutally honest peer-level evaluation analysis outlining the exact structural depth of their answers. Do not sugarcoat flaws." : "Active session live."}",
    "gapsToFix": ${forceSessionConclusion ? "A flat JSON array of strings listing specific engineering gaps, missing keywords, or structural holes spotted across their answers." : "[]"}
}

DYNAMIC CLOSURE EVALUATION MATRIX RULES:
If isConcluded is true, grade their performance strictly based on the available evidence submitted up to this exact point:
1. If the session stopped early due to a timeout flag, apply a minor speed penalty to their communication score metric.
2. Provide short, bulletproof entries inside your compiled gapsToFix array list detailing the technical topics they flubbed or bypassed.`;

        // --- STAGE 3: EXECUTE GROQ COMPILATION PIPELINE ---
        // Splice our fresh system mandate variables straight into the prompt history array package
        const cleanPayloadPayloadArray = [
            { role: "system", content: systemPrompt },
            ...chatHistory
        ];

        const groqCompletionResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: cleanPayloadPayloadArray,
            temperature: 0.3, // Kept crisp and deterministic to prevent hallucination echoes
            max_tokens: 1200,
            response_format: { type: "json_object" } // Enforces strict JSON string payload parsing on the hardware layer
        });

        // Parse and extract the structured content response
        const rawJsonStringOutput = groqCompletionResponse.choices[0].message.content;
        const parsedReportObjectPayload = JSON.parse(rawJsonStringOutput);

        // Send the fully formulated data package back to your index.html client script
        return res.status(200).json(parsedReportObjectPayload);

    } catch (error) {
        console.error("🚨 API ROUTE CRASH ERROR:", error);
        return res.status(500).json({ 
            error: "Internal server processing failure inside interview simulation compiler.", 
            details: error.message 
        });
    }
}
