import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: "Method not allowed." });
    }

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: "Unauthorized access request." });
        }

        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zlzprbespegemxnhwnuu.supabase.co',
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        const token = authHeader.replace("Bearer ", "");
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({ error: "Invalid session token." });
        }

        return res.status(200).json({ token: process.env.GEMINI_API_KEY });
    } catch (error) {
        return res.status(500).json({ error: "Internal server authentication failure.", details: error.message });
    }
}
