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

        // ─── STRICT TECHNICAL QUESTION LIFECYCLE TRACKER ────────────────
        // We only increment the count if the assistant message contains an actual question mark.
        // This ensures conversational fluff blocks never count against the 5-question quota.
        const totalTechnicalQuestionsAsked = chatHistory.filter(msg => 
            msg.role === "assistant" && 
            msg.content.includes("?") &&
            !msg.content.includes(activeInterviewer.title)
        ).length;

        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        
        // Final evaluation triggers exactly after the candidate answers the 5th question
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= 5 || isTimeCeilingReached;
        // ──────────────────────────────────────────────────────────────────

        const systemPrompt = `You are ${activeInterviewer.name}, a ${activeInterviewer.title} conducting a highly critical technical mock interview.

Target Role Requirements:
${jobDescription}

Candidate Resume Profile:
${resume}

STRICT PACING AND CONVERSATIONAL CONTRACT:
1. You must deliver exactly 5 comprehensive technical questions throughout this mock session.
2. Current Pacing State: [ Technical Questions Asked So Far: ${totalTechnicalQuestionsAsked} / 5 ].
3. CRITICAL: Never deploy a transitional message or remark (e.g., "Great job, let's move to the next question") as a standalone message. You MUST append the actual technical scenario question directly inside that very same turn. Every single response you send while isConcluded is false MUST end with a clear technical question mark "?".
4. Once totalTechnicalQuestionsAsked reaches 5, or if a timeout occurs, you must immediately set "isConcluded" to true, write a brief sign-off statement in "aiMessage", and generate the final grade.

DATA OUTPUT SCHEMA:
You must output a raw JSON object matching this schema exactly. Do not use markdown backticks wrappers:
{
    "aiMessage": "Your next technical engineering problem ending with a '?'. If concluding, write your final goodbye wrap-up text.",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
    "score": ${forceSessionConclusion ? "An integer between 1 and 100 based on their performance." : "0"},
    "verdict": "${forceSessionConclusion ? "Set to 'OFFER EXTENDED (PROVISIONAL)' if score >= 70, otherwise set to 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "A piercing, unvarnished peer-level technical evaluation review." : "Active session live."}",
    "gapsToFix": ${forceSessionConclusion ? "A flat string array of architectural or knowledge deficiencies found across their answers." : "[]"}
}

CRITICAL RULES:
- If isConcluded is false, score MUST be 0, verdict MUST be "PENDING", and gapsToFix MUST be [].`;

        const cleanPayloadArray = [
            { role: "system", content: systemPrompt },
            ...chatHistory
        ];

        const groqCompletionResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: cleanPayloadArray,
            temperature: 0.2, 
            max_tokens: 1200,
            response_format: { type: "json_object" }
        });

        const rawJsonStringOutput = groqCompletionResponse.choices[0].message.content;
        const parsedReportObjectPayload = JSON.parse(rawJsonStringOutput);

        // ─── DEFENSIVE VERIFICATION LAYER ─────────────────────────────────
        // Clean up data formatting before returning the payload to the frontend
        if (parsedReportObjectPayload.isConcluded) {
            let finalCalculatedScore = parseInt(parsedReportObjectPayload.score) || 0;
            
            // Handle decimal score conversions
            if (finalCalculatedScore <= 10 && finalCalculatedScore > 0) {
                finalCalculatedScore = finalCalculatedScore * 10;
            }
            parsedReportObjectPayload.score = finalCalculatedScore;

            // Standardize output verdicts based on score thresholds
            if (finalCalculatedScore >= 70) {
                parsedReportObjectPayload.verdict = "OFFER EXTENDED (PROVISIONAL)";
            } else {
                parsedReportObjectPayload.verdict = "REJECTED";
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
