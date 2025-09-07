const http = require("http");
const express = require("express");
const path = require("path");
const { Server } = require("socket.io");
const rateLimit = require("express-rate-limit");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP"
});

app.use(limiter);
app.use(express.json());
app.use(express.static(path.resolve("./public")));

// Store active users and rooms
let usersCount = 0;
let activeUsers = new Map();
let messageHistory = [];
let rooms = new Map();
const MAX_HISTORY = 50;

// Profanity filter (basic implementation)
const profanityWords = ['spam', 'badword1', 'badword2']; // Add more as needed
function filterProfanity(text) {
    let filtered = text;
    profanityWords.forEach(word => {
        const regex = new RegExp(word, 'gi');
        filtered = filtered.replace(regex, '*'.repeat(word.length));
    });
    return filtered;
}

// Generate unique user ID
function generateUserId() {
    return Math.random().toString(36).substr(2, 9);
}

io.on("connection", (socket) => {
    const userId = generateUserId();
    const userColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`;
    
    usersCount++;
    activeUsers.set(socket.id, {
        id: userId,
        color: userColor,
        joinTime: new Date(),
        messageCount: 0,
        isTyping: false,
        nickname: `User${Math.floor(Math.random() * 9999)}`
    });

    // Send user info and current state
    socket.emit("user-info", {
        id: userId,
        color: userColor,
        nickname: activeUsers.get(socket.id).nickname
    });
    
    // Send recent message history
    socket.emit("message-history", messageHistory);
    
    // Broadcast user count
    io.emit("user-count", usersCount);
    
    // Notify others about new user
    socket.broadcast.emit("user-joined", {
        id: userId,
        nickname: activeUsers.get(socket.id).nickname
    });

    socket.on("disconnect", () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            usersCount--;
            socket.broadcast.emit("user-left", {
                id: user.id,
                nickname: user.nickname
            });
            activeUsers.delete(socket.id);
            io.emit("user-count", usersCount);
        }
    });

    socket.on("user-message", (msgData) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;

        // Rate limiting per user
        user.messageCount++;
        if (user.messageCount > 10) { // Max 10 messages per session burst
            socket.emit("rate-limited", "Please slow down your messaging rate.");
            return;
        }

        // Reset message count after 1 minute
        setTimeout(() => {
            if (activeUsers.has(socket.id)) {
                user.messageCount = Math.max(0, user.messageCount - 1);
            }
        }, 60000);

        // Filter profanity
        const filteredText = filterProfanity(msgData.text);
        
        const enhancedMsgData = {
            ...msgData,
            text: filteredText,
            userId: user.id,
            nickname: user.nickname,
            color: user.color,
            timestamp: new Date().toISOString(),
            edited: false
        };

        // Store in history
        messageHistory.push(enhancedMsgData);
        if (messageHistory.length > MAX_HISTORY) {
            messageHistory.shift();
        }

        // Broadcast to all other users
        socket.broadcast.emit("message", enhancedMsgData);
    });

    socket.on("typing-start", () => {
        const user = activeUsers.get(socket.id);
        if (user && !user.isTyping) {
            user.isTyping = true;
            socket.broadcast.emit("user-typing-start", {
                userId: user.id,
                nickname: user.nickname
            });
        }
    });

    socket.on("typing-stop", () => {
        const user = activeUsers.get(socket.id);
        if (user && user.isTyping) {
            user.isTyping = false;
            socket.broadcast.emit("user-typing-stop", {
                userId: user.id,
                nickname: user.nickname
            });
        }
    });

    socket.on("change-nickname", (newNickname) => {
        const user = activeUsers.get(socket.id);
        if (user && newNickname && newNickname.length <= 20) {
            const oldNickname = user.nickname;
            user.nickname = filterProfanity(newNickname.trim());
            
            socket.emit("nickname-changed", user.nickname);
            socket.broadcast.emit("nickname-update", {
                userId: user.id,
                oldNickname,
                newNickname: user.nickname
            });
        }
    });

    socket.on("delete-message", (messageId) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;

        const messageIndex = messageHistory.findIndex(msg => 
            msg.id === messageId && msg.userId === user.id
        );

        if (messageIndex !== -1) {
            messageHistory.splice(messageIndex, 1);
            io.emit("message-deleted", messageId);
        }
    });

    socket.on("edit-message", (data) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;

        const message = messageHistory.find(msg => 
            msg.id === data.messageId && msg.userId === user.id
        );

        if (message) {
            message.text = filterProfanity(data.newText);
            message.edited = true;
            message.editedAt = new Date().toISOString();
            
            io.emit("message-edited", {
                messageId: data.messageId,
                newText: message.text,
                edited: true
            });
        }
    });

    socket.on("request-user-list", () => {
        const userList = Array.from(activeUsers.values()).map(user => ({
            id: user.id,
            nickname: user.nickname,
            color: user.color,
            isTyping: user.isTyping
        }));
        socket.emit("user-list", userList);
    });

    // Heartbeat to detect disconnections
    socket.on("ping", (callback) => {
        callback();
    });
});

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        users: usersCount,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// API endpoint to get stats
app.get("/api/stats", (req, res) => {
    res.json({
        activeUsers: usersCount,
        totalMessages: messageHistory.length,
        uptime: Math.floor(process.uptime())
    });
});

app.get("/", (req, res) => {
    return res.sendFile(path.resolve("./public/index.html"));
});

// Error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

const PORT = process.env.PORT || 9000;
server.listen(PORT, () => {
    console.log(`🚀 ControVerse server started at http://localhost:${PORT}`);
    console.log(`📊 Health check available at http://localhost:${PORT}/health`);
});