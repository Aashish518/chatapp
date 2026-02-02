import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import io from "socket.io-client";
import {
  FiSend,
  FiLogOut,
  FiSearch,
  FiMenu,
  FiX,
  FiMoreVertical,
  FiUser,
  FiCheck,
} from "react-icons/fi";
import { BsCheckAll } from "react-icons/bs";

const Dashboard = ({ setIsAuthenticated }) => {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [socket, setSocket] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("all"); // 'all', 'unread'
  const [isTyping, setIsTyping] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [userLastSeen, setUserLastSeen] = useState({});
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const selectedUserRef = useRef(null); // Add Ref to track selected user without stale closures
  const navigate = useNavigate();

  // Keep ref synced with state
  useEffect(() => {
    selectedUserRef.current = selectedUser;
  }, [selectedUser]);

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem("user"));
    setCurrentUser(user);

    const socketConnection = io(`${import.meta.env.VITE_BACK_URL}`);
    setSocket(socketConnection);

    socketConnection.emit("user-connected", user.id);

    socketConnection.on("receive-message", (message) => {
      setMessages((prev) => [...prev, message]);

      // Mark message as delivered
      socketConnection.emit("message-delivered", {
        messageId: message._id,
        senderId: message.senderId,
      });

      // Update users list (re-sort and increment unread)
      setUsers((prevUsers) => {
        const updatedUsers = prevUsers.map((u) => {
          if (u._id === message.senderId) {
            // If not currently selected user, increment unread
            // Note: selectedUser from state might be stale in this callback if not careful, 
            // but selectedUser is not in dependency array of this effect.
            // We can check if the message roomId matches current chat, but simpler to just increment always 
            // and let the "read" logic handle clearing it if we are in that chat?
            // Actually, the read logic is in a separate useEffect.
            // Let's rely on the fact that if we are in chat, we emit 'messages-read' shortly after.
            // But for the UI counter, we should increment.
            return {
              ...u,
              unreadCount: (u.unreadCount || 0) + 1,
              lastMessage: { createdAt: message.createdAt }
            };
          }
          return u;
        });
        // Sort by last message time
        return updatedUsers.sort((a, b) => {
          const timeA = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
          const timeB = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
          return timeB - timeA;
        });
      });
    });

    socketConnection.on("message-sent", (message) => {
      setMessages((prev) => [...prev, message]);

      // Update users list (re-sort for SENT message too, to bump user to top)
      setUsers((prevUsers) => {
        const updatedUsers = prevUsers.map((u) => {
          if (u._id === message.receiverId) {
            return {
              ...u,
              lastMessage: { createdAt: message.createdAt }
            };
          }
          return u;
        });
        return updatedUsers.sort((a, b) => {
          const timeA = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
          const timeB = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
          return timeB - timeA;
        });
      });
    });

    socketConnection.on("message-status-update", (data) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg._id === data.messageId ? { ...msg, status: data.status } : msg
        )
      );
    });

    socketConnection.on("messages-read-update", (data) => {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.roomId === data.roomId && msg.senderId === user.id
            ? { ...msg, status: "read" }
            : msg
        )
      );
    });

    socketConnection.on("user-typing", (data) => {
      if (data.senderId === selectedUserRef.current?._id) {
        setIsTyping(true);
      }
    });

    socketConnection.on("user-stop-typing", (data) => {
      if (data.senderId === selectedUserRef.current?._id) {
        setIsTyping(false);
      }
    });

    socketConnection.on("user-status", (data) => {
      setOnlineUsers((prev) => {
        const newSet = new Set(prev);
        if (data.status === "online") {
          newSet.add(data.userId);
        } else {
          newSet.delete(data.userId);
          if (data.lastSeen) {
            setUserLastSeen((prevLastSeen) => ({
              ...prevLastSeen,
              [data.userId]: data.lastSeen,
            }));
          }
        }
        return newSet;
      });
    });

    socketConnection.on("new-user-registered", (newUser) => {
      setUsers((prev) => {
        // Check if already exists to be safe
        if (prev.find(u => u._id === newUser.id)) return prev;

        return [...prev, {
          ...newUser,
          _id: newUser.id, // Ensure ID format matches
          unreadCount: 0,
          lastMessage: null
        }];
      });

      if (newUser.isOnline) {
        setOnlineUsers((prev) => new Set(prev).add(newUser.id));
      }
    });

    fetchUsers();

    return () => {
      socketConnection.disconnect();
    };
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (selectedUser) {
      fetchMessages();
    }
  }, [selectedUser]);

  // Mark messages as read when viewing a chat
  useEffect(() => {
    if (selectedUser && socket && messages.length > 0) {
      const roomId = getRoomId(currentUser.id, selectedUser._id);
      const hasUnreadMessages = messages.some(
        (msg) => msg.receiverId === currentUser.id && msg.status !== "read"
      );

      if (hasUnreadMessages) {
        // Mark as read via API
        const token = localStorage.getItem("token");
        axios.put(
          `${import.meta.env.VITE_BACK_URL}/api/messages/read/${roomId}`,
          {},
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        // Emit socket event to notify sender
        socket.emit("messages-read", {
          roomId,
          userId: currentUser.id,
          senderId: selectedUser._id,
        });

        // Update local user state to clear unread count
        setUsers((prevUsers) => {
          return prevUsers.map((u) => {
            if (u._id === selectedUser._id) {
              return { ...u, unreadCount: 0 };
            }
            return u;
          });
        });
      }
    }
  }, [selectedUser, messages]);

  const fetchUsers = async () => {
    try {
      const token = localStorage.getItem("token");
      const response = await axios.get(`${import.meta.env.VITE_BACK_URL}/api/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUsers(response.data);

      // Initialize online users and last seen from fetched data
      const online = new Set();
      const lastSeenData = {};

      response.data.forEach(u => {
        if (u.isOnline) {
          online.add(u._id);
        }
        if (u.lastSeen) {
          lastSeenData[u._id] = u.lastSeen;
        }
      });

      setOnlineUsers(online);
      setUserLastSeen(lastSeenData);

    } catch (error) {
      console.error("Error fetching users:", error);
    }
  };

  const fetchMessages = async () => {
    if (!selectedUser || !currentUser) return;

    const roomId = getRoomId(currentUser.id, selectedUser._id);
    try {
      const token = localStorage.getItem("token");
      const response = await axios.get(
        `${import.meta.env.VITE_BACK_URL}/api/messages/${roomId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      setMessages(response.data);
    } catch (error) {
      console.error("Error fetching messages:", error);
    }
  };

  const getRoomId = (userId1, userId2) => {
    return [userId1, userId2].sort().join("-");
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedUser || !socket) return;

    const roomId = getRoomId(currentUser.id, selectedUser._id);

    socket.emit("send-message", {
      roomId,
      senderId: currentUser.id,
      receiverId: selectedUser._id,
      content: newMessage,
    });

    socket.emit("stop-typing", {
      senderId: currentUser.id,
      receiverId: selectedUser._id,
    });

    setNewMessage("");
  };

  const handleTyping = (e) => {
    setNewMessage(e.target.value);

    if (!socket || !selectedUser) return;

    socket.emit("typing", {
      senderId: currentUser.id,
      receiverId: selectedUser._id,
    });

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      socket.emit("stop-typing", {
        senderId: currentUser.id,
        receiverId: selectedUser._id,
      });
    }, 1000);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setIsAuthenticated(false);
    if (socket) socket.disconnect();
    navigate("/login");
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const filteredUsers = users
    .filter((user) =>
      user.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .filter((user) => {
      if (filterType === 'unread') {
        return user.unreadCount > 0;
      }
      return true;
    });

  const getMessageDateGroup = (date) => {
    const today = new Date();
    const messageDate = new Date(date);

    if (
      messageDate.getDate() === today.getDate() &&
      messageDate.getMonth() === today.getMonth() &&
      messageDate.getFullYear() === today.getFullYear()
    ) {
      return "Today";
    }

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (
      messageDate.getDate() === yesterday.getDate() &&
      messageDate.getMonth() === yesterday.getMonth() &&
      messageDate.getFullYear() === yesterday.getFullYear()
    ) {
      return "Yesterday";
    }

    return messageDate.toLocaleDateString("en-US", { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatLastSeen = (userId) => {
    const lastSeen = userLastSeen[userId];
    if (!lastSeen) return "Last seen recently";

    const date = new Date(lastSeen);
    return `Last seen at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  const renderMessageStatus = (message) => {
    if (message.senderId !== currentUser.id) return null;

    switch (message.status) {
      case "sent":
        return <FiCheck className="text-gray-400 text-sm" />;
      case "delivered":
        return <BsCheckAll className="text-gray-200 text-base" />;
      case "read":
        return <BsCheckAll className="text-blue-400 text-base" />;
      default:
        return null;
    }
  };

  return (
    <div className="flex h-dvh bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <div
        className={`${selectedUser ? "hidden md:flex" : "flex w-full"
          } md:w-80 flex-col border-r border-gray-200 bg-white z-30`}
      >
        {/* Sidebar Header */}
        <div className="p-4 border-b border-gray-200 bg-linear-to-r from-teal-500 to-cyan-500">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3">
              <div className="relative">
                {currentUser?.image ? (
                  <img
                    src={currentUser.image}
                    alt={currentUser.name}
                    className="w-12 h-12 rounded-full object-cover object-top border-2 border-white"
                  />
                ) : (
                  <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center">
                    <FiUser className="text-teal-500 text-xl" />
                  </div>
                )}
                <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
              </div>
              <div className="text-white">
                <h2 className="font-semibold text-lg">{currentUser?.name}</h2>
                <p className="text-xs text-teal-100">Online</p>
              </div>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-lg bg-white/90 backdrop-blur text-gray-800 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white mb-2"
            />
            <div className="flex space-x-2">
              <button
                onClick={() => setFilterType('all')}
                className={`flex-1 text-xs py-1 rounded-md transition-colors font-medium ${filterType === 'all' ? 'bg-white text-teal-600' : 'bg-white/20 text-white hover:bg-white/30'}`}
              >
                All
              </button>
              <button
                onClick={() => setFilterType('unread')}
                className={`flex-1 text-xs py-1 rounded-md transition-colors font-medium ${filterType === 'unread' ? 'bg-white text-teal-600' : 'bg-white/20 text-white hover:bg-white/30'}`}
              >
                Unread
              </button>
            </div>
          </div>
        </div>

        {/* Users List */}
        <div className="flex-1 overflow-y-auto">
          {filteredUsers.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">No users found</div>
          ) : (
            filteredUsers.map((user) => (
              <div
                key={user._id}
                onClick={() => setSelectedUser(user)}
                className={`flex items-center space-x-3 p-4 cursor-pointer transition-colors ${selectedUser?._id === user._id
                  ? "bg-teal-50 border-l-4 border-teal-500"
                  : "hover:bg-gray-50"
                  }`}
              >
                <div className="relative">
                  {user.image ? (
                    <img
                      src={user.image}
                      alt={user.name}
                      className="w-12 h-12 rounded-full object-cover object-top"
                    />
                  ) : (
                    <div className="w-12 h-12 bg-linear-to-br from-teal-400 to-cyan-400 rounded-full flex items-center justify-center text-white font-semibold">
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  {onlineUsers.has(user._id) && (
                    <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline mb-1">
                    <h3 className="font-semibold text-gray-800 truncate">
                      {user.name}
                    </h3>
                    {user.lastMessage && (
                      <span className="text-[10px] text-gray-400">
                        {new Date(user.lastMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-gray-500 truncate flex-1">
                      {onlineUsers.has(user._id) ? "Online" : formatLastSeen(user._id)}
                    </p>
                    {user.unreadCount > 0 && (
                      <div className="min-w-5 h-5 bg-orange-500 rounded-full flex items-center justify-center px-1.5 ml-2">
                        <span className="text-[10px] text-white font-bold">{user.unreadCount}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Logout Button */}
        <div className="p-4 border-t border-gray-200">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center space-x-2 bg-red-500 text-white py-3 rounded-xl hover:bg-red-600 transition-colors font-semibold"
          >
            <FiLogOut />
            <span>Logout</span>
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className={`${selectedUser ? "flex" : "hidden md:flex"} flex-1 flex-col h-dvh bg-white`}>
        {selectedUser ? (
          <>
            {/* Chat Header */}
            <div className="bg-white border-b border-gray-200 p-4 flex items-center justify-between shadow-sm sticky top-0 z-10">
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => setSelectedUser(null)}
                  className="md:hidden text-gray-600 hover:bg-gray-100 p-2 rounded-lg transition"
                >
                  <FiX size={24} />
                </button>
                <div className="relative">
                  {selectedUser.image ? (
                    <img
                      src={selectedUser.image}
                      alt={selectedUser.name}
                      className="w-10 h-10 rounded-full object-cover object-top"
                    />
                  ) : (
                    <div className="w-10 h-10 bg-linear-to-br from-teal-400 to-cyan-400 rounded-full flex items-center justify-center text-white font-semibold">
                      {selectedUser.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  {onlineUsers.has(selectedUser._id) && (
                    <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
                  )}
                </div>
                <div>
                  <h3 className="font-semibold text-gray-800">
                    {selectedUser.name}
                  </h3>
                  <p className="text-xs text-gray-500">
                    {onlineUsers.has(selectedUser._id)
                      ? "Online"
                      : formatLastSeen(selectedUser._id)}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <button className="text-gray-400 hover:text-gray-600 transition">
                  <FiSearch size={20} />
                </button>
                <button className="text-gray-400 hover:text-gray-600 transition">
                  <FiMoreVertical size={20} />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-linear-to-b from-gray-50 to-white">
              {messages.map((message, index) => {
                const isOwnMessage = message.senderId === currentUser.id;

                const showDateHeader = index === 0 ||
                  getMessageDateGroup(message.createdAt) !== getMessageDateGroup(messages[index - 1].createdAt);

                return (
                  <React.Fragment key={message._id || index}>
                    {showDateHeader && (
                      <div className="flex justify-center my-4">
                        <span className="bg-gray-200 text-gray-600 text-xs px-3 py-1 rounded-full shadow-xs">
                          {getMessageDateGroup(message.createdAt)}
                        </span>
                      </div>
                    )}
                    <div
                      className={`flex ${isOwnMessage ? "justify-end" : "justify-start"
                        }`}
                    >
                      <div
                        className={`max-w-xs md:max-w-md lg:max-w-lg px-4 py-2 rounded-2xl shadow-sm ${isOwnMessage
                          ? "bg-linear-to-r from-teal-500 to-cyan-500 text-white rounded-br-none"
                          : "bg-white text-gray-800 border border-gray-200 rounded-bl-none"
                          }`}
                      >
                        <p className="wrap-break-word">{message.content}</p>
                        <div className="flex items-center justify-end gap-1 mt-1">
                          <p
                            className={`text-xs ${isOwnMessage ? "text-teal-100" : "text-gray-500"
                              }`}
                          >
                            {formatTime(message.createdAt)}
                          </p>
                          {renderMessageStatus(message)}
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
              {isTyping && (
                <div className="flex justify-start">
                  <div className="bg-white border border-gray-200 px-4 py-3 rounded-2xl rounded-bl-none shadow-sm">
                    <div className="flex space-x-2">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100"></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200"></div>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Message Input */}
            <div className="bg-white border-t border-gray-200 p-4 sticky bottom-0 z-10">
              <form onSubmit={handleSendMessage} className="flex space-x-3">
                <input
                  type="text"
                  value={newMessage}
                  onChange={handleTyping}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                />
                <button
                  type="submit"
                  disabled={!newMessage.trim()}
                  className="bg-linear-to-r from-teal-500 to-cyan-500 text-white p-3 rounded-full hover:from-teal-600 hover:to-cyan-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
                >
                  <FiSend size={20} />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center bg-linear-to-br from-teal-50 to-cyan-50">
            <div className="text-center">
              <div className="w-32 h-32 bg-linear-to-br from-teal-400 to-cyan-400 rounded-full flex items-center justify-center mx-auto mb-6 shadow-xl">
                <svg
                  className="w-16 h-16 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </div>
              <h2 className="text-3xl font-bold text-gray-700 mb-3">
                Welcome to SecureChat
              </h2>
              <p className="text-gray-500 text-lg">
                Select a user to start messaging
              </p>
              <p className="text-gray-400 text-sm mt-2">
                All messages are end-to-end encrypted
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;