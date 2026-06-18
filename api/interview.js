import { Groq } from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Initialize Supabase admin auto-verify instance to securely check user tiers on the backend
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zlzprbespegemxnhwnuu.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role to bypass RLS for quick profile lookups
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed." });
    }

    try {
        // ─── STAGE 1: PAYLOAD EXTRACTION & SECURE TIER VERIFICATION ───────
        // We now extract the 'tier' sent from the frontend
        const { jobDescription, resume, chatHistory, isHintRequest, tier: frontendTier } = req.body;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: "Missing required profile parameters." });
        }

        // Default to what the frontend claims, but we will verify it below
        let userTier = frontendTier ? frontendTier.toLowerCase() : 'free'; 
        let userId = null;

        // Extract the user token from Authorization header to check their real subscription tier
        const authHeader = req.headers.authorization;
        
        if (authHeader) {
            const token = authHeader.replace("Bearer ", "");
            const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
            if (!authError && user) {
                userId = user.id;
                // Query your profiles table securely
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('tier')
                    .eq('id', userId)
                    .single();
                
                if (profile && profile.tier) {
                    userTier = profile.tier.toLowerCase(); // The database truth overrides the frontend
                }
            }
        }

        // 🔥 THE FIX: Give free beta users the Elite AI brain, but respect Pro/Elite tiers
        if (userTier === 'free') {
            userTier = 'elite'; 
        }

        // ─── STAGE 2: DYNAMIC TIER ENFORCEMENT CONFIG ─────────────────────

        // ─── STAGE 2: DYNAMIC TIER ENFORCEMENT CONFIG ─────────────────────
        let maxQuestions = 5;
        let timeCeilingSeconds = 300; // 5 mins free
        let groqModel = "llama-3.1-8b-instant"; // Standard model
        let maxHintsAllowed = 1;

        if (userTier === 'pro') {
            timeCeilingSeconds = 1200; // 20 mins pro
            maxHintsAllowed = 5;
        } else if (userTier === 'elite') {
            timeCeilingSeconds = 2700; // 45 mins elite
            groqModel = "llama-3.3-70b-versatile"; // Smart model routing for architecture depth
            maxHintsAllowed = 999; // Essentially unlimited
        }

        // Smart Hint Detection
        const lastUserMessage = chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === "user" 
            ? chatHistory[chatHistory.length - 1].content.toLowerCase() 
            : "";
        const isHintMode = isHintRequest === true || lastUserMessage.includes("hint") || lastUserMessage.includes("help");

        // Calculate hint count and question limits
        const totalHintsUsed = chatHistory.filter(msg => msg.role === "assistant" && msg.content.includes("[HINT]")).length;
        const assistantMessageCount = chatHistory.filter(msg => msg.role === "assistant" && !msg.content.includes("[HINT]")).length;
        const totalTechnicalQuestionsAsked = Math.max(0, assistantMessageCount - 1);

        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= maxQuestions || isTimeCeilingReached;
        
        let conclusionReason = "N/A";
        if (isTimeCeilingReached) conclusionReason = "TIME_EXPIRED";
        else if (totalTechnicalQuestionsAsked >= maxQuestions) conclusionReason = "ALL_QUESTIONS_ANSWERED";

        

        // ─── STAGE 3: ADAPTIVE DOMAIN SYSTEM PROMPT ─────────────────────
        const systemPrompt = `You are an expert corporate interviewer tailored precisely to the domain of the provided Job Description.
${userTier === 'elite' ? "You are interviewing a high-level candidate. Drill deep into fine-grained distributed systems architecture, race conditions, edge-case failure modes, and micro-optimizations. Be rigorous." : ""}

Target Role Context:
${jobDescription}

Candidate Resume Profile:
${resume}

YOUR PERSONA MANDATE:
- Dynamically invent a highly realistic name, an industry-accurate corporate title, and a fictitious company matching the job description on turn 1. Maintain it consistently.
- CRITICAL TURN 1 RULE: On your very first message, you MUST introduce yourself AND immediately ask the first technical scenario question. Do not wait for the candidate to say hello.

STRICT PACING AND CONVERSATIONAL CONTRACT:
1. You must deliver exactly 5 comprehensive domain-specific interview questions. This is a standalone 5-question sprint.
2. Current Progress State: [ Questions Asked So Far: ${totalTechnicalQuestionsAsked} / 5 ].
3. ${isHintMode ? 
    "HINT DIRECTIVE ACTIVE: The candidate is asking for a hint. You MUST start your response exactly with '[HINT]'. Provide a brief, conceptual clue. DO NOT ask a new question. DO NOT answer the current question entirely." : 
    "THE HUMAN ELEMENT: Briefly react to the candidate's previous answer before asking the next question. Validate good points or critique technical flaws."}
4. ${isHintMode ? "NO QUESTION MARK ALLOWED: You are just providing a clue. Do not end your message with a question mark." : "THE QUESTION MARK RULE: Every single active response MUST end with a clear technical question mark '?'."}
5. SESSION CONCLUSION STATUS: [ ${forceSessionConclusion ? `TRUE - THE INTERVIEW IS OVER.` : `FALSE - THE INTERVIEW IS ACTIVE.`} ].

GRADING OBJECTIVE DIRECTIVE:
${forceSessionConclusion ? `The interview has ended. Evaluate performance.
${userTier === 'free' ? "TIER PRIVILEGE: This user is on the FREE sandbox. You MUST write a brief, vague 1-2 sentence high-level summary for the 'brutallyHonestReview' and leave 'gapsToFix' completely empty. Do not provide diagnostic secrets." : "TIER PRIVILEGE: This user is PRO/ELITE. Provide a piercing, unvarnished peer-level technical review focusing completely on their gaps."}` : `The interview is active. Do not generate final grades yet.`}

DATA OUTPUT SCHEMA:
You must output a raw JSON object matching this schema exactly:
{{"aiMessage": "${forceSessionConclusion ? (conclusionReason === 'TIME_EXPIRED' ? 'We are unfortunately out of time for today. Thank you for your time, we will be in touch with feedback.' : 'Thank you for walking me through those scenarios. That concludes our technical questions for today. We appreciate your time and will follow up shortly.') : (isHintMode ? '[HINT] Give a conceptual clue to help them answer. DO NOT ask a question. DO NOT end with a question mark.' : 'First, briefly react to their previous answer. Then, ask your next tailored interview question ending with a ?.')}",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
"score": ${forceSessionConclusion ? "Generate a highly dynamic, precise integer between 1 and 100 based strictly on technical accuracy and depth. Do NOT default to 92 or 85. Use the full spectrum (e.g., 73, 88, 96)." : "0"},    "verdict": "${forceSessionConclusion ? "Set to 'ACCEPTED' if score >= 70, otherwise set to 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "Your review string context based on Tier rules." : "Active session live."}",
"gapsToFix": ${forceSessionConclusion ? "A flat string array of exactly 2-3 specific constructive areas, weaknesses, or advanced edge-cases to study further. You MUST provide at least 2 items, even if the candidate performed perfectly." : "[]"}}`;

        // ─── STAGE 4: EXECUTE GROQ COMPILATION PIPELINE ─────────────────
        const groqCompletionResponse = await groq.chat.completions.create({
            model: groqModel, 
            messages: [{ role: "system", content: systemPrompt }, ...chatHistory],
            temperature: 0.15, 
            max_tokens: 1200,
            response_format: { type: "json_object" }
        });

        const parsedReportObjectPayload = JSON.parse(groqCompletionResponse.choices[0].message.content);

        // ─── STAGE 5: DEFENSIVE VERIFICATION SHIELD & AI HANDCUFFS ──────
        if (parsedReportObjectPayload.isConcluded === true && forceSessionConclusion === false) {
            parsedReportObjectPayload.isConcluded = false;
            parsedReportObjectPayload.score = 0;
            parsedReportObjectPayload.verdict = "PENDING";
            parsedReportObjectPayload.gapsToFix = [];
        }

        // Clean missing parameters if model hallucinated free constraints
        if (userTier === 'free' && forceSessionConclusion) {
            parsedReportObjectPayload.gapsToFix = []; // Hard lock data gaps for free users
        }

        return res.status(200).json(parsedReportObjectPayload);

    } catch (error) {
        console.error("🚨 API ROUTE CRASH ERROR:", error);
        return res.status(500).json({ error: "Internal server processing failure.", details: error.message });
    }
}
