const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    roomId: String,
    senderId: String,
    receiverId: String,
    content: String,
    senderContent: String,
    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);