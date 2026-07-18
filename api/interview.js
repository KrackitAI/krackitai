import { Groq } from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

// maxDuration must live INSIDE config for Pages Router API routes (a bare
// top-level export only works in App Router and is silently ignored here).
// Also adding a bodyParser size limit: every turn resends the full resume,
// JD, and growing chat history, so the default 1mb cap can get hit on
// longer sessions.
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '5mb',
        },
    },
    maxDuration: 60,
};

// Single model for every tier. llama-3.1-8b-instant and llama-3.3-70b-versatile
// are both deprecated on Groq; openai/gpt-oss-20b is the current recommended
// replacement for both, and comes out cheaper than the old 70b elite route
// while still being a meaningfully stronger reasoner than the old 8b route.
const GROQ_MODEL = "openai/gpt-oss-20b";

// ---------------------------------------------------------------------------
// SENIORITY DETECTION — deterministic, keyword-based, runs entirely in JS.
// This deliberately does NOT cost an extra LLM call: it's a regex pass over
// the job description text, feeding into both the question-style guidance
// given to the interviewer AND the rubric weighting below. A real hiring
// manager calibrates both difficulty and what they're listening for based
// on the level of the role — this is that same judgment made explicit and
// consistent instead of left to the model to infer differently each run.
// ---------------------------------------------------------------------------
function detectSeniorityLevel(jobDescription) {
    const jd = jobDescription.toLowerCase();

    if (/\b(director|vp|vice president|head of engineering)\b/.test(jd)) return 'lead';
    if (/\b(engineering manager|eng\.?\s?manager|team lead|tech lead|technical lead)\b/.test(jd)) return 'lead';
    if (/\b(principal|distinguished|staff engineer|staff software)\b/.test(jd)) return 'senior';
    if (/\bsr\.?\s|senior\b/.test(jd)) return 'senior';
    if (/\b(junior|jr\.?\s|entry.level|new grad|graduate program|internship|intern\b|associate engineer)\b/.test(jd)) return 'entry';
    if (/\b(0-1 year|0-2 years|1-2 years of experience)\b/.test(jd)) return 'entry';

    return 'mid';
}

// Question style/difficulty guidance injected into the system prompt.
// This is the actual "senior interviewer judgment" layer: what to ask and
// what standard to hold the answer to, calibrated to the role's level.
const SENIORITY_GUIDANCE = {
    entry: `SENIORITY CALIBRATION — ENTRY LEVEL: This is a junior/entry-level role. Ask fundamentals-testing questions with a reasonably well-defined scope — test whether they understand core concepts and can reason through a guided problem, not open-ended ambiguous scenarios. Give credit for sound reasoning process even if the final answer isn't perfect. Do not expect architecture-level tradeoff discussions.`,
    mid: `SENIORITY CALIBRATION — MID LEVEL: This is a mid-level individual contributor role. Ask practical, applied questions grounded in realistic day-to-day scenarios — debugging a real failure, extending an existing system, making a reasonable tradeoff on a bounded problem. Expect solid fundamentals plus some independent judgment, but not extensive organizational ambiguity.`,
    senior: `SENIORITY CALIBRATION — SENIOR/STAFF LEVEL: This is a senior or staff-level role. Ask questions involving genuine tradeoffs with no single correct answer — system design under real constraints, weighing competing priorities (performance vs. maintainability vs. time-to-ship), edge cases, and failure modes. Expect them to justify their decisions and reasoning, not just state conclusions.`,
    lead: `SENIORITY CALIBRATION — LEAD/MANAGEMENT LEVEL: This role involves technical leadership or people management. Blend technical judgment questions with realistic people/process scenarios — guiding a team through a contentious technical decision, handling a disagreement with a peer or report, prioritizing competing stakeholder asks, or unblocking a stuck engineer. Technical depth still matters, but judgment and communication carry equal or greater weight here.`
};

// Rubric point weights per level (each triple sums to 10, so with scores
// 1-10 per category the max possible total stays 100 — same ceiling as
// before, just redistributed). Reasoning: entry-level hires are judged more
// on fundamentals + coachability than deep role-specific fit, since they're
// expected to grow into it. Mid-level keeps the original 5/3/2 split. Senior
// roles weight demonstrated fit to THIS role's specific technical demands
// more heavily. Lead/management roles weight communication highest, since
// that's the core function of the job, not a secondary skill.
const RUBRIC_WEIGHTS = {
    entry:  { tech: 5, jd: 2, comm: 3 },
    mid:    { tech: 5, jd: 3, comm: 2 },
    senior: { tech: 4, jd: 4, comm: 2 },
    lead:   { tech: 3, jd: 3, comm: 4 }
};

const REPORT_SCHEMA = {
    type: "object",
    properties: {
        aiMessage: { type: "string" },
        isConcluded: { type: "boolean" },
        rubric: {
            type: "object",
            properties: {
                technical_depth: {
                    type: "object",
                    properties: { score: { type: "integer" }, reason: { type: "string" } },
                    required: ["score", "reason"],
                    additionalProperties: false
                },
                jd_alignment: {
                    type: "object",
                    properties: { score: { type: "integer" }, reason: { type: "string" } },
                    required: ["score", "reason"],
                    additionalProperties: false
                },
                communication_clarity: {
                    type: "object",
                    properties: { score: { type: "integer" }, reason: { type: "string" } },
                    required: ["score", "reason"],
                    additionalProperties: false
                }
            },
            required: ["technical_depth", "jd_alignment", "communication_clarity"],
            additionalProperties: false
        },
        verdict: { type: "string", enum: ["ACCEPTED", "REJECTED", "PENDING"] },
        brutallyHonestReview: { type: "string" },
        highlightReel: { type: "array", items: { type: "string" } },
        gapsToFix: { type: "array", items: { type: "string" } },
        behavioralAssessment: {
            type: "object",
            properties: {
                note: { type: "string" },
                severity: { type: "string", enum: ["none", "minor", "major"] }
            },
            required: ["note", "severity"],
            additionalProperties: false
        }
    },
    required: [
        "aiMessage", "isConcluded", "rubric", "verdict", "brutallyHonestReview",
        "highlightReel", "gapsToFix", "behavioralAssessment"
    ],
    additionalProperties: false
};

function sanitizeJson(rawContent) {
    const backticks = String.fromCharCode(96, 96, 96);
    return rawContent
        .trim()
        .replace(new RegExp('^' + backticks + '(?:json)?\\n?', 'gi'), '')
        .replace(new RegExp(backticks + '$', 'g'), '')
        .trim();
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed." });
    }

    // Both clients are constructed here, inside the handler, rather than at
    // module scope. groq-sdk and @supabase/supabase-js both throw SYNCHRONOUSLY
    // at construction time if their key argument is missing — and a throw at
    // module load happens before this file's try/catch even exists, which
    // crashes the whole function and returns Vercel's generic non-JSON error
    // page instead of a real JSON response (this is exactly what produced the
    // "A server e..." / "not valid JSON" error on the frontend).
    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: "GROQ_API_KEY is not configured on the server." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured on the server." });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zlzprbespegemxnhwnuu.supabase.co',
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    try {
        // ─── STAGE 1: PAYLOAD EXTRACTION & SECURE TIER VERIFICATION ───────
        const { jobDescription, resume, chatHistory, isHintRequest, tier: frontendTier } = req.body;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: "Missing required profile parameters." });
        }

        let userTier = frontendTier ? frontendTier.toLowerCase() : 'free';
        let userId = null;

        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.replace("Bearer ", "");
            const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
            if (!authError && user) {
                userId = user.id;
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('tier')
                    .eq('id', userId)
                    .single();

                if (profile && profile.tier) {
                    userTier = profile.tier.toLowerCase();
                }
            }
        }

        // Beta: give free users the Elite prompt treatment. (Left exactly as-is —
        // not part of this fix pass, per instruction.)
        if (userTier === 'free') {
            userTier = 'elite';
        }

        // ─── STAGE 2: DYNAMIC TIER ENFORCEMENT CONFIG ─────────────────────
        let maxQuestions = 5;
        let timeCeilingSeconds = 300;
        let maxHintsAllowed = 1;

        if (userTier === 'pro') {
            timeCeilingSeconds = 1200;
            maxHintsAllowed = 5;
        } else if (userTier === 'elite') {
            timeCeilingSeconds = 2700;
            maxHintsAllowed = 999;
        }

        const isHintMode = isHintRequest === true;

        const totalHintsUsed = chatHistory.filter(msg => msg.role === "assistant" && msg.content.includes("[HINT]")).length;
        const assistantMessageCount = chatHistory.filter(msg => msg.role === "assistant" && !msg.content.includes("[HINT]")).length;
        const totalTechnicalQuestionsAsked = Math.max(0, assistantMessageCount - 1);

        // ─── STAGE 2b: SERVER-SIDE HINT ENFORCEMENT (was computed but never
        // checked before — free/pro users had no real hint cap) ───────────
        if (isHintMode && totalHintsUsed >= maxHintsAllowed) {
            return res.status(403).json({
                error: "PAYWALL_TRIGGERED",
                reason: "HINT_LIMIT_REACHED",
                message: `You've used all ${maxHintsAllowed} hint(s) available on your current plan.`
            });
        }

        const clientSignaledTimeUp = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));

        // ─── STAGE 2c: OPTIONAL SERVER-SIDE TIME VALIDATION ───────────────
        // If the frontend sends `sessionStartedAt` (ISO timestamp), we verify
        // the time limit server-side too, instead of trusting only the
        // client-injected note. Not sent by the current frontend yet — until
        // it is, this is a no-op and behavior is unchanged.
        let serverSignaledTimeUp = false;
        if (req.body.sessionStartedAt) {
            const startedAt = new Date(req.body.sessionStartedAt);
            if (!isNaN(startedAt)) {
                const elapsedSeconds = (Date.now() - startedAt.getTime()) / 1000;
                serverSignaledTimeUp = elapsedSeconds > timeCeilingSeconds;
            }
        }

        const isTimeCeilingReached = clientSignaledTimeUp || serverSignaledTimeUp;
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= maxQuestions || isTimeCeilingReached;

        let conclusionReason = "N/A";
        if (isTimeCeilingReached) conclusionReason = "TIME_EXPIRED";
        else if (totalTechnicalQuestionsAsked >= maxQuestions) conclusionReason = "ALL_QUESTIONS_ANSWERED";

        // ─── STAGE 2d: SENIORITY DETECTION ────────────────────────────────
        const seniorityLevel = detectSeniorityLevel(jobDescription);
        const seniorityGuidance = SENIORITY_GUIDANCE[seniorityLevel];
        const rubricWeights = RUBRIC_WEIGHTS[seniorityLevel];

        // ─── STAGE 3: ADAPTIVE DOMAIN + SENIORITY SYSTEM PROMPT ──────────
        const systemPrompt = `You are an expert corporate interviewer tailored precisely to the domain of the provided Job Description.
${userTier === 'elite' ? "You are interviewing a high-level candidate. Identify the specific technical domain and depth implied by the job description below, and drill into THAT domain's hardest real-world edge cases, architecture tradeoffs, and failure modes — not a generic computer-science checklist. Be rigorous, but stay relevant to the actual role." : ""}

${seniorityGuidance}

Target Role Context:
${jobDescription}

Candidate Resume Profile:
${resume}

YOUR PERSONA MANDATE:
- Dynamically invent a highly realistic name, an industry-accurate corporate title, and a fictitious company matching the job description on turn 1. Maintain it consistently.
- CRITICAL TURN 1 RULE: On your very first message, you MUST introduce yourself AND immediately ask the first technical scenario question. Do not wait for the candidate to say hello.

STRICT PACING AND CONVERSATIONAL CONTRACT:
1. You must deliver exactly 5 comprehensive domain-specific interview questions, calibrated to the seniority level above. This is a standalone 5-question sprint.
2. Current Progress State: [ Questions Asked So Far: ${totalTechnicalQuestionsAsked} / 5 ].
3. ${isHintMode ?
        "HINT DIRECTIVE ACTIVE: The candidate is stuck. You MUST start your response exactly with '[HINT]'. Provide a STRICT 1-sentence conceptual nudge. You are FORBIDDEN from writing code snippets, FORBIDDEN from revealing the direct answer, and FORBIDDEN from asking follow-up questions." :
        "THE HUMAN ELEMENT: Briefly react to the candidate's previous answer before asking the next question. Validate good points or critique technical flaws. Also silently note anything about HOW they communicate (dismissive, defensive, unprofessional, evasive, or genuinely collaborative and clear) — you'll be asked to report on this at the end."}
4. ${isHintMode ? "NO QUESTION MARK ALLOWED: You are just providing a clue. Do not end your message with a question mark." : "THE QUESTION MARK RULE: Every single active response MUST end with a clear technical question mark '?'."}
5. SESSION CONCLUSION STATUS: [ ${forceSessionConclusion ? `TRUE - THE INTERVIEW IS OVER.` : `FALSE - THE INTERVIEW IS ACTIVE.`} ].

GRADING OBJECTIVE DIRECTIVE:
${forceSessionConclusion ? `The interview has ended. Evaluate performance, holding them to the standard appropriate for the seniority level described above — do not grade a junior candidate against a staff-level bar or vice versa.
${userTier === 'free' ? "TIER PRIVILEGE: This user is on the FREE sandbox. You MUST write a brief, vague 1-2 sentence high-level summary for the 'brutallyHonestReview' and leave 'gapsToFix' completely empty. Do not provide diagnostic secrets." : "TIER PRIVILEGE: This user is PRO/ELITE. Provide a piercing, unvarnished peer-level technical review focusing completely on their gaps."}

BEHAVIORAL ASSESSMENT: Based on the whole conversation, set behavioralAssessment.severity to "major" ONLY if the candidate was genuinely unprofessional, dismissive, or evasive in a way that would concern a real hiring manager. Use "minor" for small issues (rambling, mild defensiveness). Use "none" if communication was professional. Put a short factual note either way.` : `The interview is active. Do not generate final grades yet. Still fill behavioralAssessment with {"note": "Active session live.", "severity": "none"}.`}

DATA OUTPUT SCHEMA:
You must output a raw JSON object matching this schema exactly:
{
"aiMessage": "${forceSessionConclusion ? (conclusionReason === 'TIME_EXPIRED' ? 'We are unfortunately out of time for today. Thank you for your time, we will be in touch with feedback.' : 'Thank you for walking me through those scenarios. That concludes our technical questions for today. We appreciate your time and will follow up shortly.') : (isHintMode ? '[HINT] Strict 1-sentence conceptual nudge. NO CODE. NO DIRECT ANSWERS. NO QUESTIONS.' : 'First, briefly react to their previous answer. Then, ask your next tailored interview question ending with a ?.')}",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
    "rubric": {
        "technical_depth": { "score": ${forceSessionConclusion ? "<Integer 1-10>" : "0"}, "reason": "${forceSessionConclusion ? "<Max 10 words justifying tech accuracy>" : ""}" },
        "jd_alignment": { "score": ${forceSessionConclusion ? "<Integer 1-10>" : "0"}, "reason": "${forceSessionConclusion ? "<Max 10 words justifying JD alignment>" : ""}" },
        "communication_clarity": { "score": ${forceSessionConclusion ? "<Integer 1-10>" : "0"}, "reason": "${forceSessionConclusion ? "<Max 10 words critiquing articulation>" : ""}" }
    },
    "verdict": "${forceSessionConclusion ? "Set to 'ACCEPTED' if score >= 70, otherwise set to 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? (userTier === 'free' ? "Max 15 words. Vague high-level summary." : "Max 2 sentences. Piercing, unvarnished technical review.") : "Active session live."}",
    "highlightReel": ${forceSessionConclusion ? "A string array of exactly 2 short bullet points (max 10 words each) of what they did well." : "[]"},
    "gapsToFix": ${forceSessionConclusion ? "A string array of exactly 3 short bullet points (max 10 words each) of weaknesses to study." : "[]"},
    "behavioralAssessment": { "note": "<short factual note>", "severity": "none | minor | major" }
}`;

        // ─── STAGE 4: EXECUTE GROQ COMPILATION PIPELINE ─────────────────
        const groqCompletionResponse = await groq.chat.completions.create({
            model: GROQ_MODEL,
            messages: [{ role: "system", content: systemPrompt }, ...chatHistory],
            temperature: 0.15,
            max_completion_tokens: 1500,
            reasoning_effort: "low",
            response_format: {
                type: "json_schema",
                json_schema: { name: "interview_turn", strict: true, schema: REPORT_SCHEMA }
            }
        });

        const parsedReportObjectPayload = JSON.parse(sanitizeJson(groqCompletionResponse.choices[0].message.content));

        // ─── STAGE 4b: DETERMINISTIC SCORING ENGINE ─────────────────────
        if (parsedReportObjectPayload.isConcluded === true && parsedReportObjectPayload.rubric) {
            const r = parsedReportObjectPayload.rubric;

            const techPoints = (r.technical_depth?.score || 0) * rubricWeights.tech;
            const jdPoints = (r.jd_alignment?.score || 0) * rubricWeights.jd;
            const commPoints = (r.communication_clarity?.score || 0) * rubricWeights.comm;

            let score = techPoints + jdPoints + commPoints;

            // Behavioral red flags can now actually move the outcome, instead of
            // being generated and then ignored. A "major" flag caps the score
            // the same way a missing dealbreaker skill caps the resume screener.
            const severity = parsedReportObjectPayload.behavioralAssessment?.severity;
            if (severity === 'major') {
                score = Math.min(score, 40);
            } else if (severity === 'minor') {
                score = Math.min(score, 80);
            }

            parsedReportObjectPayload.score = Math.round(score);
            parsedReportObjectPayload.verdict = score >= 70 ? "ACCEPTED" : "REJECTED";
        } else if (!parsedReportObjectPayload.score) {
            parsedReportObjectPayload.score = 0;
        }

        // ─── STAGE 5: DEFENSIVE VERIFICATION SHIELD & AI HANDCUFFS ──────
        if (parsedReportObjectPayload.isConcluded === true && forceSessionConclusion === false) {
            parsedReportObjectPayload.isConcluded = false;
            parsedReportObjectPayload.score = 0;
            parsedReportObjectPayload.verdict = "PENDING";
            parsedReportObjectPayload.gapsToFix = [];
        }

        if (userTier === 'free' && forceSessionConclusion) {
            parsedReportObjectPayload.gapsToFix = [];
        }

        // Echoed back so the frontend can show "This session was calibrated
        // for a Senior-level role" or similar, and so it's easy to verify
        // detection is working correctly on real job descriptions.
        parsedReportObjectPayload.detectedSeniorityLevel = seniorityLevel;

        return res.status(200).json(parsedReportObjectPayload);

    } catch (error) {
        console.error("🚨 API ROUTE CRASH ERROR:", error);
        return res.status(500).json({ error: "Internal server processing failure.", details: error.message });
    }
}
