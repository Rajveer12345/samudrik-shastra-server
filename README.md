# Samudrik Shastra — Complete System

## What you get
- **samudrik-shastra** (artifact) — User-facing palm reading app with payment
- **samudrik-admin** (artifact) — Admin dashboard with stats, all readings, revenue
- **samudrik-backend/** — Node.js server (deploy once on Render.com, FREE)

---

## Deploy in 15 minutes

### 1. Get API Key
- Go to console.anthropic.com → API Keys → Create Key → copy it

### 2. Get Razorpay Keys (free account)
- Go to razorpay.com → Sign Up (free)
- Dashboard → Settings → API Keys → Generate Test Key
- Copy Key ID (rzp_test_...) and Key Secret

### 3. Push to GitHub
- Create new repo on github.com
- Upload all 3 files from samudrik-backend folder

### 4. Deploy on Render.com (FREE)
- render.com → New → Web Service → connect your GitHub repo
- Build Command: `npm install`
- Start Command: `node server.js`
- Instance Type: Free

### 5. Set Environment Variables on Render
| Variable | Value |
|----------|-------|
| ANTHROPIC_API_KEY | sk-ant-your-key |
| ADMIN_PASSWORD | your-chosen-password |
| FREE_MODE | true (while testing) |
| RAZORPAY_KEY_ID | rzp_test_... |
| RAZORPAY_KEY_SECRET | your-secret |
| PRICE_INR | 49900 (= ₹499) |

### 6. Deploy → copy your server URL

### 7. Configure the apps
- Open samudrik-shastra artifact → ⚙ Settings → paste server URL
- Open samudrik-admin artifact → enter server URL + admin password

### 8. Go live with payments
- Test everything with FREE_MODE=true first
- When ready: change FREE_MODE=false on Render → redeploy
- Switch Razorpay to live keys (rzp_live_...)

---

## Revenue model examples
| Price | 10 readings/day | 30 readings/day |
|-------|-----------------|-----------------|
| ₹99   | ₹29,700/month   | ₹89,100/month   |
| ₹299  | ₹89,700/month   | ₹2,69,100/month |
| ₹499  | ₹1,49,700/month | ₹4,49,700/month |

Razorpay charges 2% per transaction.
