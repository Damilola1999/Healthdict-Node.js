require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const { Resend } = require("resend");

const app = express();
const PORT = process.env.PORT || 5000;


/* ---------- Constants (keep in sync with the frontend) ---------- */


const CONSULTATION_TYPES = [
    "Weight Management",
    "Medical Nutrition Therapy",
    "Health Meal Planning",
    "Nutrition Education",
];


const TIMES = [
    "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM",
  "2:00 PM", "2:30 PM", "3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM",
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- Middleware ---------- */

app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "20kb"}));


const allowedOrigins = (process.env.FRONTEND_URL || "")
.split(",")
.map((o) => o.trim().replace(/\/$/, ""))
.filter(Boolean);

app.use(
    cors({
        origin(origin, cb) {
            if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
            cb(new Error("Not allowed by CORS"));
        },
    })
);

app.use(
    "/api/",
    rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false})
);

/* ---------- Database ---------- */
const appointmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    type: { type: String, required: true, enum: CONSULTATION_TYPES },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, required: true, enum: TIMES },
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending" },
  },
  { timestamps: true }
);

// One booking per slot — prevents double booking
appointmentSchema.index({ date:1, time: 1 }, { unique: true });
const Appointment = mongoose.model("Appointment", appointmentSchema);

/* ---------- Email (Resend uses HTTPS, so it works on Render's free tier) ---------- */
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.MAIL_FROM || "Nourish by Hannah <onboarding@resend.dev>";

const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const prettyDate = (ymd) => 
    new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });

    async function sendEmails(a) {
        if (!resend) return console.warn("RESEND_API_KEY missing - skipping emails");
        const when = `${prettyDate(a.date)} at ${a.time}`;


          try {
    if (process.env.NOTIFY_EMAIL) {
      await resend.emails.send({
        from: FROM,
        to: process.env.NOTIFY_EMAIL,
        replyTo: a.email,
        subject: `New appointment request: ${a.name} — ${when}`,
        html: `
          <h2>New appointment request</h2>
          <p><b>Name:</b> ${esc(a.name)}</p>
          <p><b>Email:</b> ${esc(a.email)}</p>
          <p><b>Phone:</b> ${esc(a.phone)}</p>
          <p><b>Type:</b> ${esc(a.type)}</p>
          <p><b>When:</b> ${esc(when)}</p>
          <p><b>Notes:</b> ${esc(a.notes) || "—"}</p>`,
      });
    }
    if (process.env.SEND_CLIENT_CONFIRMATION === "true") {
      await resend.emails.send({
        from: FROM,
        to: a.email,
        subject: "We've received your appointment request",
        html: `
          <p>Hi ${esc(a.name)},</p>
          <p>Thank you for booking a <b>${esc(a.type)}</b> consultation with Nourish by Hannah.</p>
          <p>Requested slot: <b>${esc(when)}</b></p>
          <p>We'll confirm shortly by email or WhatsApp.</p>`,
      });
    }
  } catch (err) {
    console.error("Email error:", err.message); // never fail the booking because of email
  }
    }

    /* ---------- Routes ---------- */

    app.get("/", (_req, res) => res.send("Nourish booking API is running"));
    app.get("/health", (_req, res) => res.json({  ok: true}));

    // Booked times for a date, so the UI can disable them
    app.get("/api/appointments/booked", async (req, res) => {
        const { date } = req.query;
        if (!DATE_RE.test(date || "")) return res.status(400).json({ message: "date must be YYYY-MM-DD" });
         const rows = await Appointment.find({ date, status: { $ne: "cancelled" } }).select("time -_id");
  res.json({ date, booked: rows.map((r) => r.time) });
});

app.post("/api/appointments", async (req, res) => {
  const { name, email, phone, type, notes = "", date, time } = req.body || {};

  if (!name?.trim() || !email?.trim() || !phone?.trim() || !type)
    return res.status(400).json({ message: "Please fill in all the required fields." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ message: "Please enter a valid email address." });
  if (!CONSULTATION_TYPES.includes(type)) return res.status(400).json({ message: "Invalid consultation type." });
  if (!DATE_RE.test(date || "") || !TIMES.includes(time))
    return res.status(400).json({ message: "Please choose a valid date and time." });

  const todayLagos = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  if (date < todayLagos) return res.status(400).json({ message: "Please choose a future date." });

  try {
    const appointment = await Appointment.create({ name, email, phone, type, notes, date, time });
    sendEmails(appointment).catch((err) => console.error("Email error:", err.message)); // fire and forget
    res.status(201).json({ message: "Appointment request received.", id: appointment._id });
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ message: "That time slot has just been taken. Please pick another." });
    console.error(err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});



/* ---------- Errors ---------- */
app.use((err, _req, res, _next) => {
  if (err.message === "Not allowed by CORS") return res.status(403).json({ message: err.message });
  console.error(err);
  res.status(500).json({ message: "Server error" });
});

/* ---------- Start ---------- */
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });
