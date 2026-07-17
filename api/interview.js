import { Groq } from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

// 🔥 CRITICAL FIX: Overrides Vercel's default 10s timeout to prevent report card crashes
export const maxDuration = 60; 

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

        
        // Smart Hint Detection (STRICT MODE)
        const isHintMode = isHintRequest === true;

        // Calculate hint count and question limits
        const totalHintsUsed = chatHistory.filter(msg => msg.role === "assistant" && msg.content.includes("[HINT]")).length;
        const assistantMessageCount = chatHistory.filter(msg => msg.role === "assistant" && !msg.content.includes("[HINT]")).length;
        const totalTechnicalQuestionsAsked = Math.max(0, assistantMessageCount - 1);

        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= maxQuestions || isTimeCeilingReached;
        
        let conclusionReason = "N/A";
        if (isTimeCeilingReached) conclusionReason = "TIME_EXPIRED";
        else if (totalTechnicalQuestionsAsked >= maxQuestions) conclusionReason = "ALL_QUESTIONS_ANSWERED";

        


