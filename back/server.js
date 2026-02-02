const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const socketIo = require("socket.io");
const crypto = require("crypto");
require('dotenv').config();


const User = require("./models/User");
const Message = require("./models/Message");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const JWT_SECRET = process.env.JWT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error("ENCRYPTION_KEY is not set!");
  process.exit(1);
}


// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Encryption/Decryption functions
function encrypt(text) {
  const algorithm = "aes-256-cbc";
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
  const algorithm = "aes-256-cbc";
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const parts = text.split(":");
  const iv = Buffer.from(parts[0], "hex");
  const encryptedText = parts[1];
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encryptedText, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "Access token required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid token" });
    req.user = user;
    next();
  });
};

// Routes
// Register
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, image } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const publicKey = crypto.randomBytes(32).toString("hex");

    const user = new User({
      name,
      email,
      password: hashedPassword,
      publicKey,
      image,
    });

    await user.save();

    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    const newUser = {
      id: user._id,
      name: user.name,
      email: user.email,
      image: user.image,
      isOnline: true, // Default to online as they just registered and will likely login/connect
      lastSeen: new Date()
    };

    // Broadcast new user to all connected clients
    io.emit("new-user-registered", newUser);

    res.status(201).json({
      token,
      user: newUser,
    });
  } catch (error) {
    res.status(500).json({ message: "Error registering user", error: error.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, image: user.image },
    });
  } catch (error) {
    res.status(500).json({ message: "Error logging in", error: error.message });
  }
});

// Get all users (for chat list) with unread count and last message
app.get("/api/users", authenticateToken, async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.id } }).select(
      "-password -publicKey"
    );

    const usersWithData = await Promise.all(
      users.map(async (user) => {
        const unreadCount = await Message.countDocuments({
          senderId: user._id,
          receiverId: req.user.id,
          status: { $ne: "read" },
        });

        const lastMessage = await Message.findOne({
          roomId: {
            $in: [
              [req.user.id, user._id].sort().join("-"),
            ]
          }
        }).sort({ createdAt: -1 });

        return {
          ...user.toObject(),
          unreadCount,
          lastMessage: lastMessage
            ? {
              content: "?", // We don't decrypt here for performance/security in list view unless needed, or we safely can if performance allows. For now let's just use timestamp for sorting. 
              // Actually, the plan implies we might want to show it. But encryption makes it tricky without decrypting. 
              // Let's just return the timestamp and maybe a placeholder or 'Encrypted Message' for now if we don't want to decrypt all.
              // However, the prompt asked for "filter like new message chat top", so timestamp is critical.
              createdAt: lastMessage.createdAt,
            }
            : null,
        };
      })
    );

    // Sort users: Users with unread messages first, then by last message time
    usersWithData.sort((a, b) => {
      // Prioritize unread
      // if (b.unreadCount !== a.unreadCount) return b.unreadCount - a.unreadCount; 
      // Actually user just asked for "filter like new message chat top or current chat top". 
      // Typically this means sorting by last activity.

      const timeA = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const timeB = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return timeB - timeA;
    });

    res.json(usersWithData);
  } catch (error) {
    res.status(500).json({ message: "Error fetching users", error: error.message });
  }
});

// Get messages for a room
app.get("/api/messages/:roomId", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const messages = await Message.find({ roomId }).sort({ createdAt: 1 });

    // Decrypt messages
    const decryptedMessages = messages.map((msg) => {
      let content;
      if (msg.senderId === req.user.id) {
        content = decrypt(msg.senderContent);
      } else {
        content = decrypt(msg.content);
      }

      return {
        _id: msg._id,
        roomId: msg.roomId,
        senderId: msg.senderId,
        receiverId: msg.receiverId,
        content,
        status: msg.status,
        createdAt: msg.createdAt,
      };
    });

    res.json(decryptedMessages);
  } catch (error) {
    res.status(500).json({ message: "Error fetching messages", error: error.message });
  }
});

// Mark messages as read
app.put("/api/messages/read/:roomId", authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;

    // Update all messages in the room where the current user is the receiver
    await Message.updateMany(
      {
        roomId,
        receiverId: req.user.id,
        status: { $ne: "read" }
      },
      { status: "read" }
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Error marking messages as read", error: error.message });
  }
});

// Get current user
app.get("/api/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password -publicKey");
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: "Error fetching user", error: error.message });
  }
});

// Socket.IO connection
const activeUsers = new Map();

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("user-connected", async (userId) => {
    activeUsers.set(userId, socket.id);

    // Update user's online status in database
    await User.findByIdAndUpdate(userId, {
      isOnline: true,
      lastSeen: new Date()
    });

    // Broadcast online status to all users
    io.emit("user-status", { userId, status: "online" });
  });

  socket.on("send-message", async (data) => {
    try {
      const { roomId, senderId, receiverId, content } = data;

      // Encrypt message for both sender and receiver
      const encryptedContent = encrypt(content);
      const encryptedSenderContent = encrypt(content);

      const message = new Message({
        roomId,
        senderId,
        receiverId,
        content: encryptedContent,
        senderContent: encryptedSenderContent,
        status: "sent",
      });

      await message.save();

      // Check if receiver is online
      const receiverSocketId = activeUsers.get(receiverId);
      const isReceiverOnline = receiverSocketId ? true : false;

      // If receiver is online, mark as delivered
      if (isReceiverOnline) {
        message.status = "delivered";
        await message.save();
      }

      // Send to receiver
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("receive-message", {
          _id: message._id,
          roomId,
          senderId,
          receiverId,
          content,
          status: message.status,
          createdAt: message.createdAt,
        });
      }

      // Send back to sender with status
      socket.emit("message-sent", {
        _id: message._id,
        roomId,
        senderId,
        receiverId,
        content,
        status: message.status,
        createdAt: message.createdAt,
      });
    } catch (error) {
      console.error("Error sending message:", error);
      socket.emit("message-error", { message: "Failed to send message" });
    }
  });

  socket.on("message-delivered", async (data) => {
    try {
      const { messageId, senderId } = data;

      // Update message status to delivered
      await Message.findByIdAndUpdate(messageId, { status: "delivered" });

      // Notify sender
      const senderSocketId = activeUsers.get(senderId);
      if (senderSocketId) {
        io.to(senderSocketId).emit("message-status-update", {
          messageId,
          status: "delivered",
        });
      }
    } catch (error) {
      console.error("Error updating message delivery status:", error);
    }
  });

  socket.on("messages-read", async (data) => {
    try {
      const { roomId, senderId } = data;

      // Update all unread messages in the room to read
      await Message.updateMany(
        {
          roomId,
          receiverId: data.userId,
          status: { $ne: "read" }
        },
        { status: "read" }
      );

      // Notify sender about read status
      const senderSocketId = activeUsers.get(senderId);
      if (senderSocketId) {
        io.to(senderSocketId).emit("messages-read-update", {
          roomId,
        });
      }
    } catch (error) {
      console.error("Error updating message read status:", error);
    }
  });

  socket.on("typing", (data) => {
    const receiverSocketId = activeUsers.get(data.receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("user-typing", data);
    }
  });

  socket.on("stop-typing", (data) => {
    const receiverSocketId = activeUsers.get(data.receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("user-stop-typing", data);
    }
  });

  socket.on("disconnect", async () => {
    for (const [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        activeUsers.delete(userId);

        const lastSeen = new Date();
        // Update user's online status and last seen in database
        await User.findByIdAndUpdate(userId, {
          isOnline: false,
          lastSeen: lastSeen
        });

        io.emit("user-status", { userId, status: "offline", lastSeen });
        break;
      }
    }
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});