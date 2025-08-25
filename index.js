// index.js
const express = require("express");
const cors = require("cors");
const http = require("http");
require("dotenv").config();
const { Server } = require("socket.io");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();

/* =========================
   1) Config
========================= */
const PORT = process.env.PORT || 5000;
// Frontend origin (Firebase Hosting / Vercel) – env এ সেট দেবে
const CLIENT_ORIGIN =
  process.env.CLIENT_ORIGIN || "https://hurryup-e4338.web.app";

// Mongo URI (Atlas)
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI. Set it in your .env / server env.");
  process.exit(1);
}

/* =========================
   1.1) Mailer (Resend)
========================= */
// Note: Node 18+ এ global fetch আছে
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
    /**
     * send({ to, subject, html, text })
     */
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

/* ------- ছোট ইমেইল টেমপ্লেটগুলো ------- */
const emailTpl = {
  registration: (user) => `
    <div style="font-family:Arial">
      <h2>🎉 রেজিস্ট্রেশন সফল হয়েছে, ${user?.name || "ব্যবহারকারী"}!</h2>
      <p>আপনি HurryUp Express-এ সফলভাবে রেজিস্ট্রেশন করেছেন।</p>
      <p>একাউন্ট: <b>${user?.email || user?.phone || ""}</b></p>
      <hr/><small>ধন্যবাদ।</small>
    </div>`,

  bookingCreated: (bk) => `
    <div style="font-family:Arial">
      <h2>✅ বুকিং কনফার্মড</h2>
      <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
      <p>পিকআপ: ${bk.pickupAddress}</p>
      <p>ডেলিভারি: ${bk.deliveryAddress}</p>
      <p>স্ট্যাটাস: ${bk.status}</p>
      <p>মোট চার্জ: ${bk.totalCharge}৳ (ডেলিভারি চার্জ: ${bk.deliveryCharge}৳)</p>
      <hr/><small>লাইভ ট্র্যাকিংয়ের জন্য Track Parcel পেজ দেখুন।</small>
    </div>`,

  statusTransit: (bk) => `
    <div style="font-family:Arial">
      <h2>🚚 আপনার পার্সেল রওনা হয়েছে</h2>
      <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
      <p>এখন স্ট্যাটাস: <b>In-Transit</b></p>
      <p>এজেন্ট: ${bk?.deliveryAgent?.name || "Assigned"}</p>
      <hr/><small>লাইভ লোকেশন Track পেজে দেখুন।</small>
    </div>`,

  statusDelivered: (bk) => `
    <div style="font-family:Arial">
      <h2>📦 ডেলিভারি সম্পন্ন</h2>
      <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
      <p>স্ট্যাটাস: <b>Delivered</b></p>
      <hr/><small>ধন্যবাদ।</small>
    </div>`,

  statusFailed: (bk, reason) => `
    <div style="font-family:Arial">
      <h2>⚠️ ডেলিভারি ব্যর্থ</h2>
      <p>বুকিং আইডি: <b>${bk.bookingId}</b></p>
      <p>স্ট্যাটাস: <b>Failed</b></p>
      <p>কারণ: <b>${reason || "উল্লেখ নেই"}</b></p>
      <hr/><small>সাপোর্টের সাথে যোগাযোগ করুন।</small>
    </div>`,
};

/* =========================
   2) Middlewares
========================= */
app.use(express.json());
app.use(
  cors({
    origin: [CLIENT_ORIGIN],
    credentials: true,
  })
);

// Health check
app.get("/", (req, res) => res.send("API OK"));

/* =========================
   3) HTTP + Socket.IO
========================= */
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: [CLIENT_ORIGIN] },
  transports: ["websocket", "polling"],
});

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // Customer/Agent joins a booking room using bookingId (string)
  socket.on("join:order", (bookingId) => {
    if (!bookingId || typeof bookingId !== "string") return;
    socket.join(`order:${bookingId}`);
    console.log(`joined room order:${bookingId}`);
  });

  // Agent sends live location
  socket.on("loc", (payload) => {
    const bookingId = payload?.bookingId;
    const lat = parseFloat(payload?.lat);
    const lng = parseFloat(payload?.lng);
    const ts = Number(payload?.ts) || Date.now();

    if (!bookingId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    io.to(`order:${bookingId}`).emit("loc", { bookingId, lat, lng, ts });
  });

  socket.on("disconnect", () => {
    console.log("socket disconnected:", socket.id);
  });
});

/* =========================
   4) Mongo
========================= */
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

/* =========================
   5) Helpers
========================= */
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

/* =========================
   6) Routes
========================= */
/* ---- Users ---- */
app.post("/users", async (req, res) => {
  const user = req.body;
  const result = await usersCollection().insertOne(user);

  // Registration email
  if (user?.email) {
    await mailer.send({
      to: user.email,
      subject: "Registration Successful – HurryUp Express",
      html: emailTpl.registration(user),
    });
  }

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
  } catch {
    res
      .status(500)
      .send({ success: false, message: "Failed to retrieve users" });
  }
});

app.patch("/users/:id", async (req, res) => {
  const id = req.params.id;
  const filter = { _id: new ObjectId(id) };
  const { name, dob, photoUrl } = req.body;
  const result = await usersCollection().updateOne(filter, {
    $set: { name, dob, photoUrl },
  });
  res.send(result);
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

    // ids & status
    booking.bookingId = `HurryUp${Date.now().toString().slice(-6)}${Math.floor(
      Math.random() * 100
    )}`;
    booking.createdAt = new Date();
    booking.status = "pending";
    booking.chargeBreakdown = calc;

    const result = await bookingsCollection().insertOne(booking);

    // Booking confirmation email (তোমার data structure অনুযায়ী customer email = booking.email)
    if (booking?.email) {
      await mailer.send({
        to: booking.email,
        subject: `Booking Confirmed – ${booking.bookingId}`,
        html: emailTpl.bookingCreated(booking),
      });
    }

    res.status(201).send({
      success: true,
      data: {
        ...result,
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
  if (uid) query.uid = uid;
  if (status) query.status = status;
  if (id) query._id = new ObjectId(id);
  const result = await bookingsCollection().find(query).toArray();
  res.status(200).send({ success: true, data: result, count: result.length });
});

// Get bookings by user uid (for dashboard lists)
app.get("/bookings/:uid", async (req, res) => {
  const uid = req.params.uid;
  const result = await bookingsCollection().find({ uid }).toArray();
  res.send(result);
});

// Public tracking (ONE route only)
app.get("/bookings/public/:trackingId", async (req, res) => {
  try {
    const trackingId = req.params.trackingId;
    const booking = await bookingsCollection().findOne({
      bookingId: trackingId,
    });
    if (!booking)
      return res
        .status(404)
        .send({ success: false, message: "Tracking ID not found" });

    const publicData = {
      bookingId: booking.bookingId,
      status: booking.status || booking.deliveryStatus,
      deliveryStatus: booking.deliveryStatus,
      pickupAddress: booking.pickupAddress,
      deliveryAddress: booking.deliveryAddress,
      parcelType: booking.parcelType,
      parcelSize: booking.parcelSize,
      parcelWeight: booking.parcelWeight,
      createdAt: booking.createdAt,
      deliveryAgent: booking.deliveryAgent
        ? {
            name: booking.deliveryAgent.name,
            phone: booking.deliveryAgent.phone,
          }
        : null,
      updatedAt: booking.updatedAt,
    };
    res.status(200).send({ success: true, data: publicData });
  } catch {
    res
      .status(500)
      .send({ success: false, message: "Failed to retrieve tracking info" });
  }
});

// Assign agent
app.patch("/bookings/:id/assign-agent", async (req, res) => {
  try {
    const _id = req.params.id;
    const { deliveryAgent, status } = req.body;
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
        status: status || "pickedUp",
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

// Update delivery status
app.patch("/bookings/:id/deliveryStatus", async (req, res) => {
  try {
    const _id = req.params.id;
    if (!ObjectId.isValid(_id))
      return res
        .status(400)
        .send({ success: false, message: "Invalid booking ID" });

    // normalize inputs - use consistent hyphenated status names
    const statusMap = {
      pending: "pending",
      "picked-up": "picked-up",
      pickedup: "picked-up",
      pickedUp: "picked-up",
      "in-transit": "in-transit",
      intransit: "in-transit",
      delivered: "delivered",
      failed: "failed",
    };
    const incoming = String(req.body.deliveryStatus || "").toLowerCase();
    const mapped = statusMap[incoming] || statusMap[req.body.deliveryStatus];
    const valid = ["pending", "picked-up", "in-transit", "delivered", "failed"];
    if (!mapped || !valid.includes(mapped)) {
      return res
        .status(400)
        .send({ success: false, message: "Invalid deliveryStatus" });
    }

    const $set = {
      deliveryStatus: mapped,
      status: mapped,
      updatedAt: new Date(),
    };
    if (mapped === "failed") {
      if (req.body.failureReason?.trim())
        $set.failureReason = req.body.failureReason.trim();
      $set.failedAt = new Date();
    }

    const result = await bookingsCollection().updateOne(
      { _id: new ObjectId(_id) },
      { $set }
    );
    if (!result.modifiedCount)
      return res
        .status(400)
        .send({ success: false, message: "Failed to update booking status" });

    const updated = await bookingsCollection().findOne({
      _id: new ObjectId(_id),
    });

    // ===== Email hooks =====
    const emailTo = updated?.email; // তোমার ডাটায় customer email = booking.email
    if (emailTo) {
      if (updated.status === "in-transit") {
        await mailer.send({
          to: emailTo,
          subject: `Your parcel is in-transit – ${updated.bookingId}`,
          html: emailTpl.statusTransit(updated),
        });
      } else if (updated.status === "delivered") {
        await mailer.send({
          to: emailTo,
          subject: `Delivered – ${updated.bookingId}`,
          html: emailTpl.statusDelivered(updated),
        });
      } else if (updated.status === "failed") {
        await mailer.send({
          to: emailTo,
          subject: `Delivery Failed – ${updated.bookingId}`,
          html: emailTpl.statusFailed(updated, updated.failureReason),
        });
      }
    }
    // ===== /Email hooks =====

    res.status(200).send({
      success: true,
      data: {
        bookingId: updated.bookingId,
        deliveryStatus: updated.deliveryStatus,
        status: updated.status,
        failureReason: updated.failureReason,
        failedAt: updated.failedAt,
        updatedAt: updated.updatedAt,
      },
    });
  } catch {
    res.status(500).send({ success: false, message: "Server error" });
  }
});

/* ---- Agent Requests ---- */
app.post("/agent-requests", async (req, res) => {
  try {
    const agentRequest = req.body;

    // Validate required fields
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

    // Check if user already has a pending or approved request
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

    // Generate unique request ID
    const requestId = `AGENT${Date.now().toString().slice(-6)}${Math.floor(
      Math.random() * 100
    )}`;

    // Add request metadata
    agentRequest.requestId = requestId;
    agentRequest.createdAt = new Date();
    agentRequest.status = agentRequest.status || "pending";

    const result = await agentRequestsCollection().insertOne(agentRequest);
    res.status(201).send({
      success: true,
      message: "Agent request submitted successfully",
      data: {
        ...result,
        requestId: requestId,
      },
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

    // Filter by user ID if provided
    if (uid) {
      query.uid = uid;
    }

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    // Filter by specific request ID if provided
    if (id) {
      query._id = new ObjectId(id);
    }

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

// Update agent request status (for admin approval/rejection)
app.patch("/agent-requests/:id/status", async (req, res) => {
  try {
    const requestId = req.params.id;
    const { status, reviewedBy, reviewNotes } = req.body;

    // Validate required fields
    if (!status) {
      return res.status(400).send({
        success: false,
        message: "Status is required",
      });
    }

    // Validate status values
    const validStatuses = ["pending", "approved", "rejected"];
    if (!validStatuses.includes(status)) {
      return res.status(400).send({
        success: false,
        message: `Invalid status. Valid statuses are: ${validStatuses.join(
          ", "
        )}`,
      });
    }

    // Validate request ID format
    if (!ObjectId.isValid(requestId)) {
      return res.status(400).send({
        success: false,
        message: "Invalid request ID format",
      });
    }

    // Update request status
    const updateDoc = {
      $set: {
        status: status,
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
      return res.status(404).send({
        success: false,
        message: "Agent request not found",
      });
    }

    if (result.modifiedCount === 0) {
      return res.status(400).send({
        success: false,
        message: "Failed to update agent request status",
      });
    }

    // If approved, update user role to agent
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

    // Fetch updated request
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

    // Filter by date range if provided
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) {
        matchStage.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        matchStage.createdAt.$lte = new Date(endDate);
      }
    }

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
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
    let matchStage = {};
    // Filter by date range if provided
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) {
        matchStage.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        matchStage.createdAt.$lte = new Date(endDate);
      }
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
          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
          inTransit: {
            $sum: { $cond: [{ $eq: ["$status", "in-transit"] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
          },
          pickedUp: {
            $sum: { $cond: [{ $eq: ["$status", "pickedUp"] }, 1, 0] },
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

    // Calculate success and failure rates
    const successful = stats.delivered;
    const failed = stats.total - stats.delivered;
    const successRate =
      stats.total > 0 ? ((successful / stats.total) * 100).toFixed(2) : 0;

    res.status(200).send({
      success: true,
      message: "Delivery stats retrieved successfully",
      data: {
        ...stats,
        successful,
        failed,
        successRate: parseFloat(successRate),
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
    // Filter by date range if provided
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) {
        matchStage.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        matchStage.createdAt.$lte = new Date(endDate);
      }
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

/* =========================
   7) Start Server
========================= */
(async () => {
  try {
    await client.connect();
    server.listen(PORT, () => {
      console.log("Server listening on", PORT, "origin:", CLIENT_ORIGIN);
    });
  } catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
  }
})();
