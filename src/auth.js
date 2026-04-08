 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/src/auth.js b/src/auth.js
index 0fee4d46ea38ef8320de927cd710275cdb97d56b..933cc9436746c4bc1aa57c576b2f6c3c024cec4c 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -1,45 +1,43 @@
 import crypto from 'node:crypto';
 
 export const BASE_URL = 'https://relay.bayse.markets';
 
 function getEnvOrThrow(name) {
   const value = process.env[name];
   if (!value) {
     throw new Error(`Missing required environment variable: ${name}`);
   }
   return value;
 }
 
 function hashBody(body) {
   const rawBody = body ?? '';
   return crypto.createHash('sha256').update(rawBody).digest('hex');
 }
 
 export function buildReadHeaders() {
-  const publicKey = getEnvOrThrow('BAYSE_PUBLIC_KEY');
   return {
-    'Content-Type': 'application/json',
-    'X-Public-Key': publicKey,
+    'X-Public-Key': getEnvOrThrow('BAYSE_PUBLIC_KEY'),
   };
 }
 
 export function buildWriteHeaders(method, path, body) {
   const publicKey = getEnvOrThrow('BAYSE_PUBLIC_KEY');
   const secretKey = getEnvOrThrow('BAYSE_SECRET_KEY');
-
-  const timestamp = String(Date.now());
+  const timestamp = String(Math.floor(Date.now() / 1000));
+  const upperMethod = method.toUpperCase();
   const bodyHash = hashBody(body);
-  const payload = `${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`;
+  const payload = `${timestamp}.${upperMethod}.${path}.${bodyHash}`;
 
   const signature = crypto
     .createHmac('sha256', secretKey)
     .update(payload)
     .digest('base64');
 
   return {
     'Content-Type': 'application/json',
     'X-Public-Key': publicKey,
     'X-Timestamp': timestamp,
     'X-Signature': signature,
   };
 }
 
EOF
)
