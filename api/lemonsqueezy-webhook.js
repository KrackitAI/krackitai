import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// CRITICAL: Disable Next.js body parser so we can access the raw body buffer for signature verification
export const config = {
    api: { bodyParser: false }
};

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zlzprbespegemxnhwnuu.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // 1. Read raw body as buffer for HMAC verification
        const rawBody = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => resolve(Buffer.from(data)));
            req.on('error', err => reject(err));
        });

        // 2. Verify Lemon Squeezy Signature
        const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
        const signature = req.headers['x-signature'] || '';

        const hmac = crypto.createHmac('sha256', secret);
        const digest = Buffer.from(hmac.update(rawBody).digest('hex'), 'utf8');
        const receivedSignature = Buffer.from(signature, 'utf8');

        // Prevent timing attacks during signature comparison
        if (!crypto.timingSafeEqual(digest, receivedSignature)) {
            return res.status(401).json({ error: 'Invalid webhook signature.' });
        }

        // 3. Parse Webhook Payload
        const payload = JSON.parse(rawBody.toString());
        const eventName = payload.meta.event_name;
        
        // custom_data is where we pass the Supabase User ID from the frontend when initializing checkout
        const customData = payload.meta.custom_data; 

        // 4. Handle Subscription Events
        if (eventName.startsWith('subscription_')) {
            const userId = customData?.user_id; 
            
            if (!userId) {
                console.error("Webhook failed: Missing custom_data.user_id");
                return res.status(400).json({ error: "Missing custom_data.user_id" });
            }

            const variantId = payload.data.attributes.variant_id;
            const status = payload.data.attributes.status; // 'active', 'past_due', 'expired', etc.

            // Replace these with your actual Variant IDs from the Lemon Squeezy dashboard
            const PRO_VARIANT_ID = 123456; 
            const ELITE_VARIANT_ID = 789012;

            let assignedTier = 'free'; // Default fallback (e.g. if subscription cancelled or expired)
            if (status === 'active' || status === 'on_trial') {
                if (variantId === PRO_VARIANT_ID) assignedTier = 'pro';
                if (variantId === ELITE_VARIANT_ID) assignedTier = 'elite';
            }

            // 5. Update Supabase Profile Database
            const { error } = await supabaseAdmin
                .from('profiles')
                .update({ tier: assignedTier })
                .eq('id', userId);

            if (error) throw error;
        }

        return res.status(200).json({ message: "Webhook processed successfully" });

    } catch (error) {
        console.error("Webhook processing error:", error);
        return res.status(500).json({ error: "Server processing error" });
    }
}
