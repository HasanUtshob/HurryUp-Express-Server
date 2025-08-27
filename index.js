// index.js
const express = require("express");
const cors = require("cors");
const http = require("http");
require("dotenv").config();
const { Server } = require("socket.io");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

if (typeof fetch === "undefined") {
  global.fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

const app = express();

/* ================ 1) Config ========================= */
const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN =
  process.env.CLIENT_ORIGIN || "https://hurryupexpress.netlify.app";
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI");
  process.exit(1);
}

// allow both prod + local
const ALLOWED_ORIGINS = [
  CLIENT_ORIGIN,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

/* ========================= 1.1) Mailer (Resend) ========================= */
const mailer = (() => {
  const enabled =
    String(process.env.MAIL_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) {
    return {
      send: async () =>
        console.log("[MAIL] disabled; set MAIL_ENABLED=true to enable"),
    };
  }
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM =
    process.env.MAIL_FROM || "HurryUp Express <onboarding@resend.dev>";
  if (!RESEND_API_KEY) {
    console.warn("⚠️ Missing RESEND_API_KEY. Emails will fail. Set it in .env");
  }
  return {
    send: async ({ to, subject, html, text }) => {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: FROM, to, subject, html, text }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(JSON.stringify(data));
        console.log("[MAIL] sent:", data.id || data);
      } catch (err) {
        console.error("[MAIL] failed:", err.message);
      }
    },
  };
})();

/* ------- Templates ------- */
const emailTpl = {
  registration: (user) => `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px">
      <div style="max-width:600px;margin:auto;background:white;border-radius:12px;padding:24px;box-shadow:0 4px 10px rgba(0,0,0,0.08)">
        <h2 style="color:#2563eb">🎉 রেজিস্ট্রেশন সফল!</h2>
        <p>হ্যালো, <b>${user?.name || "ব্যবহারকারী"}</b> 👋</p>
        <p>আপনি HurryUp Express-এ সফলভাবে রেজিস্ট্রেশন করেছেন।</p>
        <p>একাউন্ট: <b style="color:#111827">${
          user?.email || user?.phone || ""
        }</b></p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb"/>
        <p style="font-size:13px;color:#6b7280">ধন্যবাদ আমাদের সাথে যুক্ত হওয়ার জন্য।</p>
      </div>
    </div>`,
  bookingCreated: (bk) => `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px">
      <div style="max-width:600px;margin:auto;background:white;border-radius:12px;padding:24px;box-shadow:0 4px 10px rgba(0,0,0,0.08)">
        <h2 style="color:#16a34a">✅ বুকিং কনফার্মড</h2>
        <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
        <p>📍 পিকআপ: ${bk.pickupAddress}</p>
        <p>🎯 ডেলিভারি: ${bk.deliveryAddress}</p>
        <p>📦 স্ট্যাটাস: <b>${bk.status}</b></p>
        <p>💰 মোট চার্জ: <b>${bk.totalCharge}৳</b> (ডেলিভারি চার্জ: ${bk.deliveryCharge}৳)</p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb"/>
        <p style="font-size:13px;color:#6b7280">লাইভ ট্র্যাকিং দেখতে <b>Track Parcel</b> পেজে যান।</p>
      </div>
    </div>`,
  statusTransit: (bk) => `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px">
      <div style="max-width:600px;margin:auto;background:white;border-radius:12px;padding:24px;box-shadow:0 4px 10px rgba(0,0,0,0.08)">
        <h2 style="color:#f59e0b">🚚 আপনার পার্সেল রওনা হয়েছে</h2>
        <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
        <p>বর্তমান স্ট্যাটাস: <b style="color:#f59e0b">In-Transit</b></p>
        <p>এজেন্ট: <b>${bk?.deliveryAgent?.name || "Assigned"}</b></p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb"/>
        <p style="font-size:13px;color:#6b7280">আপনার পার্সেলের লাইভ লোকেশন <b>Track Parcel</b> পেজে দেখুন।</p>
      </div>
    </div>`,
  statusDelivered: (bk) => `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px">
      <div style="max-width:600px;margin:auto;background:white;border-radius:12px;padding:24px;box-shadow:0 4px 10px rgba(0,0,0,0.08)">
        <h2 style="color:#10b981">📦 ডেলিভারি সম্পন্ন</h2>
        <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
        <p>স্ট্যাটাস: <b style="color:#10b981">Delivered</b></p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb"/>
        <p style="font-size:13px;color:#6b7280">আমাদের সার্ভিস ব্যবহারের জন্য ধন্যবাদ।</p>
      </div>
    </div>`,
  statusFailed: (bk, reason) => `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px">
      <div style="max-width:600px;margin:auto;background:white;border-radius:12px;padding:24px;box-shadow:0 4px 10px rgba(0,0,0,0.08)">
        <h2 style="color:#ef4444">⚠️ ডেলিভারি ব্যর্থ</h2>
        <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
        <p>স্ট্যাটাস: <b style="color:#ef4444">Failed</b></p>
        <p>কারণ: <b>${reason || "উল্লেখ নেই"}</b></p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb"/>
        <p style="font-size:13px;color:#6b7280">বিস্তারিত জানার জন্য সাপোর্ট টিমের সাথে যোগাযোগ করুন।</p>
      </div>
    </div>`,
};

/* ========================= 2) Middlewares ========================= */
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Health check
app.get("/", (req, res) => res.send("API OK"));

/* ========================= 3) HTTP + Socket.IO ========================= */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PATCH"],
  },
});

/** In-memory last location cache for instant replay */
const lastLocByBooking = new Map();

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // Customer/Agent joins booking room
  socket.on("join:order", async (bookingId) => {
    if (!bookingId || typeof bookingId !== "string") return;
    const room = `order:${bookingId}`;
    socket.join(room);
    console.log(`joined room ${room}`);

    // 🔁 Immediately replay last known location (memory → Mongo fallback)
    let last = lastLocByBooking.get(bookingId);
    if (!last) {
      try {
        const doc = await bookingsCollection().findOne({ bookingId });
        if (doc?.lastLocation?.lat && doc?.lastLocation?.lng) {
          last = {
            bookingId,
            lat: Number(doc.lastLocation.lat),
            lng: Number(doc.lastLocation.lng),
            ts: Number(doc.lastLocation.ts) || Date.now(),
          };
          // warm cache
          lastLocByBooking.set(bookingId, last);
        }
      } catch (e) {
        console.warn("join:order lastLocation lookup failed:", e.message);
      }
    }
    if (last) {
      io.to(socket.id).emit("loc", last);
    }
  });

  // Agent live location
  socket.on("loc", async (payload) => {
    const bookingId = payload?.bookingId;
    const lat = parseFloat(payload?.lat);
    const lng = parseFloat(payload?.lng);
    const ts = Number(payload?.ts) || Date.now();
    if (!bookingId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const room = `order:${bookingId}`;
    const msg = { bookingId, lat, lng, ts };

    // 1) emit to room
    io.to(room).emit("loc", msg);

    // 2) cache in memory (instant replay)
    lastLocByBooking.set(bookingId, msg);

    // 3) persist to Mongo (survive restarts)
    try {
      await bookingsCollection().updateOne(
        { bookingId },
        { $set: { lastLocation: { lat, lng, ts }, updatedAt: new Date() } }
      );
    } catch (e) {
      console.warn("persist lastLocation failed:", e.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("socket disconnected:", socket.id);
  });
});

/* ========================= 4) Mongo ========================= */
const client = new MongoClient(MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
const db = () => client.db("HurryUpExpress");
const usersCollection = () => db().collection("users");
const bookingsCollection = () => db().collection("bookings");
const agentRequestsCollection = () => db().collection("agent-requests");

/* ========================= 5) Helpers ========================= */
const calculateDeliveryCharge = (zipCode, weight) => {
  let baseCharge = 160;
  const zip = parseInt(zipCode);
  if (Number.isFinite(zip) && zip >= 1000 && zip <= 1399) baseCharge = 100;

  const w = parseFloat(weight);
  const weightCharge = Number.isFinite(w) && w > 5 ? Math.ceil(w - 5) * 100 : 0;

  return {
    baseCharge,
    weightCharge,
    totalCharge: baseCharge + weightCharge,
    zipCodeRange:
      Number.isFinite(zip) && zip >= 1000 && zip <= 1399
        ? "Premium Zone (1000-1399)"
        : "Standard Zone",
  };
};

/* ========================= 6) Routes ========================= */
/* ---- Users ---- */
app.post("/users", async (req, res) => {
  const user = req.body;
  const result = await usersCollection().insertOne(user);
  res.send(result);
});

app.get("/users", async (req, res) => {
  try {
    const { uid, role } = req.query;
    const query = {};
    if (uid) query.uid = uid;
    if (role) query.role = role;
    const result = await usersCollection().find(query).toArray();
    res.status(200).send({ success: true, data: result, count: result.length });
  } catch (e) {
    res
      .status(500)
      .send({ success: false, message: "Failed to retrieve users" });
  }
});

// PATCH /users/:id — supports Mongo _id or Firebase uid
app.patch("/users/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let filter;
    if (ObjectId.isValid(id)) filter = { _id: new ObjectId(id) };
    else filter = { uid: id };

    const { name, phone, address, city, zipCode, dateOfBirth, dob, photoUrl } =
      req.body;
    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (phone !== undefined) updateFields.phone = phone;
    if (address !== undefined) updateFields.address = address;
    if (city !== undefined) updateFields.city = city;
    if (zipCode !== undefined) updateFields.zipCode = zipCode;
    if (dateOfBirth !== undefined) updateFields.dateOfBirth = dateOfBirth;
    if (dob !== undefined) updateFields.dob = dob;
    if (photoUrl !== undefined) updateFields.photoUrl = photoUrl;
    updateFields.updatedAt = new Date();

    const existingUser = await usersCollection().findOne(filter);
    if (!existingUser) {
      return res
        .status(404)
        .send({ success: false, message: "User not found" });
    }

    const result = await usersCollection().updateOne(filter, {
      $set: updateFields,
    });
    if (result.modifiedCount === 0) {
      return res.status(400).send({
        success: false,
        message: "No changes were made to the profile",
      });
    }

    res.status(200).send({
      success: true,
      message: "Profile updated successfully",
      data: {
        modifiedCount: result.modifiedCount,
        updatedFields: Object.keys(updateFields),
      },
    });
  } catch (error) {
    console.error("Error updating user profile:", error);
    res.status(500).send({
      success: false,
      message: "Failed to update profile",
      error: error.message,
    });
  }
});

app.patch("/users", async (req, res) => {
  const { uid } = req.query;
  if (!uid)
    return res.status(400).send({ success: false, message: "uid required" });
  const { lastSignInTime } = req.body;
  const result = await usersCollection().updateOne(
    { uid },
    { $set: { lastSignInTime } }
  );
  res.send(result);
});

/* ---- Bookings ---- */
// Create a booking
app.post("/bookings", async (req, res) => {
  try {
    const booking = req.body;
    const reqFields = [
      "pickupContactName",
      "pickupPhone",
      "pickupAddress",
      "deliveryContactName",
      "deliveryPhone",
      "deliveryAddress",
      "deliveryDivision",
      "deliveryZipCode",
      "parcelSize",
      "parcelType",
      "parcelWeight",
      "paymentMethod",
    ];
    for (const f of reqFields) {
      if (!booking[f])
        return res
          .status(400)
          .send({ success: false, message: `Missing ${f}` });
    }

    // charges
    const calc = calculateDeliveryCharge(
      booking.deliveryZipCode,
      booking.parcelWeight
    );
    booking.deliveryCharge = calc.baseCharge;
    booking.totalCharge = calc.totalCharge;
    booking.chargeBreakdown = calc;

    // ids & status
    booking.bookingId = `HurryUp${Date.now().toString().slice(-6)}${Math.floor(
      Math.random() * 100
    )}`;
    booking.createdAt = new Date();
    booking.status = "pending";

    const result = await bookingsCollection().insertOne(booking);

    res.status(201).send({
      success: true,
      data: {
        insertedId: result.insertedId,
        bookingId: booking.bookingId,
        chargeBreakdown: booking.chargeBreakdown,
      },
    });
  } catch (e) {
    res
      .status(500)
      .send({ success: false, message: "Failed to create booking" });
  }
});

// Query bookings
app.get("/bookings", async (req, res) => {
  const { uid, status, id } = req.query;
  const query = {};
  if (uid) query["deliveryAgent.uid"] = uid;
  if (status) query.status = status;
  if (id) query.bookingId = id;

  const result = await bookingsCollection()
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
  res.status(200).send({ success: true, data: result, count: result.length });
});

// Get bookings by user uid
app.get("/bookings/:uid", async (req, res) => {
  const uid = req.params.uid;
  const result = await bookingsCollection().find({ uid }).toArray();
  res.send(result);
});

// Public tracking (now includes lastLocation if present)
app.get("/bookings/public/:trackingId", async (req, res) => {
  try {
    const { trackingId } = req.params;
    const booking = await bookingsCollection().findOne({
      bookingId: trackingId,
    });
    if (!booking)
      return res.status(404).send({ success: false, message: "Not found" });

    const normalize = (s) =>
      (s || "").toString().toLowerCase().replace(/\s+/g, "-").replace("_", "-");
    const status = normalize(
      booking.deliveryStatus || booking.status || "pending"
    );

    const publicData = {
      bookingId: booking.bookingId,
      status,
      deliveryStatus: status,
      pickupAddress: booking.pickupAddress,
      deliveryAddress: booking.deliveryAddress,
      parcelType: booking.parcelType,
      parcelSize: booking.parcelSize,
      parcelWeight: booking.parcelWeight,
      createdAt: booking.createdAt,
      lastLocation: booking.lastLocation || null, // 👈 added
      deliveryAgent: booking.deliveryAgent
        ? {
            name: booking.deliveryAgent.name,
            phone: booking.deliveryAgent.phone,
          }
        : null,
      updatedAt: booking.updatedAt,
    };

    res.status(200).send({ success: true, data: publicData });
  } catch (e) {
    res
      .status(500)
      .send({ success: false, message: "Failed to retrieve tracking info" });
  }
});

// Assign agent
app.patch("/bookings/:id/assign-agent", async (req, res) => {
  try {
    const _id = req.params.id;
    const { deliveryAgent } = req.body;
    if (!ObjectId.isValid(_id))
      return res
        .status(400)
        .send({ success: false, message: "Invalid booking ID" });
    if (!deliveryAgent?.name)
      return res
        .status(400)
        .send({ success: false, message: "Delivery agent name is required" });

    const existing = await bookingsCollection().findOne({
      _id: new ObjectId(_id),
    });
    if (!existing)
      return res
        .status(404)
        .send({ success: false, message: "Booking not found" });
    if (existing.status !== "pending") {
      return res.status(400).send({
        success: false,
        message: `Booking is already ${existing.status}`,
      });
    }

    const updateDoc = {
      $set: {
        deliveryAgent: {
          name: deliveryAgent.name.trim(),
          phone: deliveryAgent.phone?.trim() || "",
          email: deliveryAgent.email?.trim() || "",
          assignedAt: new Date(),
          assignedBy: deliveryAgent.assignedBy || "admin",
        },
        status: "picked-up",
        deliveryStatus: "picked-up",
        updatedAt: new Date(),
      },
    };

    const result = await bookingsCollection().updateOne(
      { _id: new ObjectId(_id) },
      updateDoc
    );
    if (!result.modifiedCount)
      return res
        .status(400)
        .send({ success: false, message: "Failed to assign delivery agent" });

    const updated = await bookingsCollection().findOne({
      _id: new ObjectId(_id),
    });
    res.status(200).send({
      success: true,
      data: {
        bookingId: updated.bookingId,
        deliveryAgent: updated.deliveryAgent,
        status: updated.status,
        updatedAt: updated.updatedAt,
      },
    });
  } catch {
    res
      .status(500)
      .send({ success: false, message: "Failed to assign delivery agent" });
  }
});

// Update delivery status (whitelist + persist)
app.patch("/bookings/:id/deliveryStatus", async (req, res) => {
  try {
    const { id } = req.params;
    const { deliveryStatus, failureReason } = req.body;
    if (!deliveryStatus) {
      return res
        .status(400)
        .send({ success: false, message: "deliveryStatus required" });
    }

    // whitelist statuses
    const allowed = new Set([
      "pending",
      "picked-up",
      "in-transit",
      "delivered",
      "failed",
    ]);
    const status = String(deliveryStatus).toLowerCase();
    if (!allowed.has(status)) {
      return res
        .status(400)
        .send({ success: false, message: "Invalid status value" });
    }

    const update = {
      $set: {
        deliveryStatus: status,
        status, // alias
        updatedAt: new Date(),
      },
      $unset: {},
    };
    if (status === "failed" && failureReason) {
      update.$set.failureReason = failureReason;
      update.$set.failedAt = new Date();
    } else {
      update.$unset.failureReason = "";
      update.$unset.failedAt = "";
    }

    const result = await bookingsCollection().updateOne(
      { _id: new ObjectId(id) },
      update
    );
    if (!result.modifiedCount)
      return res
        .status(404)
        .send({ success: false, message: "Booking not found" });

    const updated = await bookingsCollection().findOne({
      _id: new ObjectId(id),
    });

    res.status(200).send({
      success: true,
      data: {
        bookingId: updated.bookingId,
        deliveryStatus: updated.deliveryStatus,
        status: updated.status,
        failureReason: updated.failureReason,
        failedAt: updated.failedAt,
        updatedAt: updated.updatedAt,
        lastLocation: updated.lastLocation || null,
      },
    });
  } catch (e) {
    res.status(500).send({ success: false, message: "Server error" });
  }
});

/* ---- Agent Requests ---- */
app.post("/agent-requests", async (req, res) => {
  try {
    const agentRequest = req.body;

    const requiredFields = [
      "name",
      "phone",
      "email",
      "vehicleType",
      "availability",
    ];
    for (const field of requiredFields) {
      if (!agentRequest[field]) {
        return res.status(400).send({
          success: false,
          message: `Missing required field: ${field}`,
        });
      }
    }

    if (agentRequest.uid) {
      const existingRequest = await agentRequestsCollection().findOne({
        uid: agentRequest.uid,
        status: { $in: ["pending", "approved"] },
      });
      if (existingRequest) {
        return res.status(400).send({
          success: false,
          message: "You already have a pending or approved agent request",
        });
      }
    }

    const requestId = `AGENT${Date.now().toString().slice(-6)}${Math.floor(
      Math.random() * 100
    )}`;
    agentRequest.requestId = requestId;
    agentRequest.createdAt = new Date();
    agentRequest.status = agentRequest.status || "pending";

    const result = await agentRequestsCollection().insertOne(agentRequest);
    res.status(201).send({
      success: true,
      message: "Agent request submitted successfully",
      data: { ...result, requestId },
    });
  } catch (error) {
    console.error("Error creating agent request:", error);
    res.status(500).send({
      success: false,
      message: "Failed to create agent request",
      error: error.message,
    });
  }
});

app.get("/agent-requests", async (req, res) => {
  try {
    const { uid, status, id } = req.query;
    let query = {};
    if (uid) query.uid = uid;
    if (status) query.status = status;
    if (id) query._id = new ObjectId(id);

    const result = await agentRequestsCollection().find(query).toArray();
    res.status(200).send({
      success: true,
      message: "Agent requests retrieved successfully",
      data: result,
      count: result.length,
    });
  } catch (error) {
    console.error("Error retrieving agent requests:", error);
    res.status(500).send({
      success: false,
      message: "Failed to retrieve agent requests",
      error: error.message,
    });
  }
});

// Update agent request status
app.patch("/agent-requests/:id/status", async (req, res) => {
  try {
    const requestId = req.params.id;
    const { status, reviewedBy, reviewNotes } = req.body;
    if (!status)
      return res
        .status(400)
        .send({ success: false, message: "Status is required" });

    const validStatuses = ["pending", "approved", "rejected"];
    if (!validStatuses.includes(status)) {
      return res.status(400).send({
        success: false,
        message: `Invalid status. Valid statuses are: ${validStatuses.join(
          ", "
        )}`,
      });
    }
    if (!ObjectId.isValid(requestId)) {
      return res
        .status(400)
        .send({ success: false, message: "Invalid request ID format" });
    }

    const updateDoc = {
      $set: {
        status,
        reviewedAt: new Date(),
        reviewedBy: reviewedBy || "admin",
        reviewNotes: reviewNotes || "",
        updatedAt: new Date(),
      },
    };

    const result = await agentRequestsCollection().updateOne(
      { _id: new ObjectId(requestId) },
      updateDoc
    );
    if (result.matchedCount === 0) {
      return res
        .status(404)
        .send({ success: false, message: "Agent request not found" });
    }
    if (result.modifiedCount === 0) {
      return res.status(400).send({
        success: false,
        message: "Failed to update agent request status",
      });
    }

    if (status === "approved") {
      const agentRequest = await agentRequestsCollection().findOne({
        _id: new ObjectId(requestId),
      });
      if (agentRequest && agentRequest.uid) {
        await usersCollection().updateOne(
          { uid: agentRequest.uid },
          {
            $set: {
              role: "agent",
              agentInfo: {
                phone: agentRequest.phone,
                vehicleType: agentRequest.vehicleType,
                availability: agentRequest.availability,
                experience: agentRequest.experience || "",
                approvedAt: new Date(),
              },
              updatedAt: new Date(),
            },
          }
        );
      }
    }

    const updatedRequest = await agentRequestsCollection().findOne({
      _id: new ObjectId(requestId),
    });
    res.status(200).send({
      success: true,
      message: "Agent request status updated successfully",
      data: {
        requestId: updatedRequest.requestId,
        status: updatedRequest.status,
        reviewedAt: updatedRequest.reviewedAt,
        updatedAt: updatedRequest.updatedAt,
      },
    });
  } catch (error) {
    console.error("Error updating agent request status:", error);
    res.status(500).send({
      success: false,
      message: "Failed to update agent request status",
      error: error.message,
    });
  }
});

/* ---- Analytics ---- */
app.get("/analytics/daily-bookings", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let matchStage = {};
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
          totalAmount: { $sum: "$totalCharge" },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const result = await bookingsCollection().aggregate(pipeline).toArray();
    res.status(200).send({
      success: true,
      message: "Daily bookings retrieved successfully",
      data: result,
    });
  } catch (error) {
    console.error("Error retrieving daily bookings:", error);
    res.status(500).send({
      success: false,
      message: "Failed to retrieve daily bookings",
      error: error.message,
    });
  }
});

app.get("/analytics/delivery-stats", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const matchStage = {};
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] },
          },
          pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
          inTransit: {
            $sum: { $cond: [{ $eq: ["$status", "in-transit"] }, 1, 0] },
          },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          pickedUp: {
            $sum: { $cond: [{ $eq: ["$status", "picked-up"] }, 1, 0] },
          },
        },
      },
    ];

    const result = await bookingsCollection().aggregate(pipeline).toArray();
    const stats = result[0] || {
      total: 0,
      delivered: 0,
      pending: 0,
      inTransit: 0,
      failed: 0,
      pickedUp: 0,
    };

    const successful = stats.delivered;
    const failed = stats.total - stats.delivered;
    const successRate = stats.total > 0 ? (successful / stats.total) * 100 : 0;

    res.status(200).send({
      success: true,
      message: "Delivery stats retrieved successfully",
      data: {
        stats,
        successful,
        failed,
        successRate: Number(successRate.toFixed(2)),
      },
    });
  } catch (error) {
    console.error("Error retrieving delivery stats:", error);
    res.status(500).send({
      success: false,
      message: "Failed to retrieve delivery stats",
      error: error.message,
    });
  }
});

app.get("/analytics/cod-summary", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let matchStage = { paymentMethod: "cod" };
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalCOD: { $sum: "$totalCharge" },
          totalCODOrders: { $sum: 1 },
          pendingCOD: {
            $sum: {
              $cond: [{ $ne: ["$status", "delivered"] }, "$totalCharge", 0],
            },
          },
          pendingCODOrders: {
            $sum: { $cond: [{ $ne: ["$status", "delivered"] }, 1, 0] },
          },
          receivedCOD: {
            $sum: {
              $cond: [{ $eq: ["$status", "delivered"] }, "$totalCharge", 0],
            },
          },
          receivedCODOrders: {
            $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] },
          },
        },
      },
    ];

    const result = await bookingsCollection().aggregate(pipeline).toArray();
    const codStats = result[0] || {
      totalCOD: 0,
      totalCODOrders: 0,
      pendingCOD: 0,
      pendingCODOrders: 0,
      receivedCOD: 0,
      receivedCODOrders: 0,
    };

    res.status(200).send({
      success: true,
      message: "COD summary retrieved successfully",
      data: codStats,
    });
  } catch (error) {
    console.error("Error retrieving COD summary:", error);
    res.status(500).send({
      success: false,
      message: "Failed to retrieve COD summary",
      error: error.message,
    });
  }
});

/* ========================= 7) Start Server ========================= */
(async () => {
  try {
    await client.connect();
    server.listen(PORT, () => {
      console.log(
        "Server listening on",
        PORT,
        "origin(s):",
        ALLOWED_ORIGINS.join(", ")
      );
    });
  } catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
  }
})();
