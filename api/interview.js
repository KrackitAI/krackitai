import { Groq } from "groq-sdk";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const INTERVIEWERS = {
    rohan: { name: "Rohan Khanna", title: "Principal Systems Architect" },
    sarah: { name: "Sarah Jenkins", title: "Director of Engineering" }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed." });
    }

    try {
        const { jobDescription, resume, chatHistory, interviewerId } = req.body;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: "Missing required profile parameters." });
        }

        const activeInterviewer = INTERVIEWERS[interviewerId] || INTERVIEWERS.rohan;

        // ─── CRITICAL HARDCODED CONNECTIONS ───────────────────────────────
        // Count EXACTLY how many times the assistant has spoken total.
        // This is a programmatic constant that the LLM text cannot mess with.
        const totalAssistantTurns = chatHistory.filter(msg => msg.role === "assistant").length;
        
        // Turn 1 = Intro
        // Turn 2 = Question 1
        // Turn 3 = Question 2
        // Turn 4 = Question 3
        // Turn 5 = Question 4
        // Turn 6 = Question 5
        const currentQuestionNumber = totalAssistantTurns; 

        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        
        // Force wrap-up immediately if they answered 5 questions OR ran out of time
        const forceSessionConclusion = currentQuestionNumber >= 6 || isTimeCeilingReached;
        // ──────────────────────────────────────────────────────────────────

        const systemPrompt = `You are ${activeInterviewer.name}, a ${activeInterviewer.title} conducting a high-stakes engineering technical mock interview.

Target Role Requirements:
${jobDescription}

Candidate Resume Profile:
${resume}

STRICT OPERATIONAL PACING CONTRACT:
1. You are running a strict 5-Question technical interview script.
2. Current Question Tracker State: [ ${currentQuestionNumber} / 5 ].
3. If currentQuestionNumber is between 1 and 5, you MUST generate an aggressive, core engineering question testing technical trade-offs. Never say goodbye, never summarize performance, and never skip asking a concrete question ending with a "?".
4. If currentQuestionNumber >= 6 OR forced conclusion is active, you are completely forbidden from asking more questions. You must immediately shut down the interview process, say goodbye cleanly in "aiMessage", and run the full grading assessment.

DATA OUTPUT ENFORCEMENT SCHEMA:
You must output a raw JSON object matching this schema exactly. Do not use markdown backticks or block wrappers:
{
    "aiMessage": "Your next technical question ending with a '?'. If concluding, write a concise goodbye message.",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
    "score": ${forceSessionConclusion ? "An absolute integer between 1 and 100. Never use decimals or fractions." : "0"},
    "verdict": "${forceSessionConclusion ? "MUST BE EXACTLY 'OFFER EXTENDED (PROVISIONAL)' OR 'REJECTED' BASED ON SCORE. NO OTHER STRINGS ALLOWED." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "Your unvarnished, direct, peer-level engineering critique. Boldly expose gaps." : "Active session live."}",
    "gapsToFix": ${forceSessionConclusion ? "A flat string array of specific engineering conceptual failures or architectural weak spots." : "[]"}
}

CRITICAL RULES:
- If isConcluded is false, score MUST be 0, verdict MUST be "PENDING", and gapsToFix MUST be [].
- Never mimic or copy user instructions. Generate only the requested database fields.`;

        const cleanPayloadArray = [
            { role: "system", content: systemPrompt },
            ...chatHistory
        ];

        const groqCompletionResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: cleanPayloadArray,
            temperature: 0.2, // Dropped to 0.2 to slam the door on creative hallucinations
            max_tokens: 1200,
            response_format: { type: "json_object" }
        });

        const rawJsonStringOutput = groqCompletionResponse.choices[0].message.content;
        const parsedReportObjectPayload = JSON.parse(rawJsonStringOutput);

        // ─── FRONTEND PROTECTION DEFENSIVE SHIELD ────────────────────────
        // Even if the LLM hallucinated, this hard-corrects the data before it returns
        if (parsedReportObjectPayload.isConcluded) {
            // Force decimal scores like 9.5 into standard 100-scale integers
            let rawScore = parseFloat(parsedReportObjectPayload.score);
            if (rawScore <= 10) rawScore = rawScore * 10; 
            parsedReportObjectPayload.score = Math.round(rawScore) || 50;

            // Strict verdict compliance alignment
            const finalCleanVerdict = String(parsedReportObjectPayload.verdict).toUpperCase();
            if (!finalCleanVerdict.includes("OFFER") && !finalCleanVerdict.includes("PASS")) {
                parsedReportObjectPayload.verdict = "REJECTED";
            } else {
                parsedReportObjectPayload.verdict = "OFFER EXTENDED (PROVISIONAL)";
            }
        }
        // ──────────────────────────────────────────────────────────────────

        return res.status(200).json(parsedReportObjectPayload);

    } catch (error) {
        console.error("🚨 API ROUTE CRASH ERROR:", error);
        return res.status(500).json({ 
            error: "Internal server processing failure.", 
            details: error.message 
        });
    }
}
