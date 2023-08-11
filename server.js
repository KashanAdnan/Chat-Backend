const express = require("express")
const mongoose = require("mongoose")
const dotenv = require("dotenv")
const jwt = require("jsonwebtoken")
const { UserModel } = require('./Model/User.js')
const cors = require('cors')
const bcrypt = require("bcryptjs")
const cookieParser = require("cookie-parser")
const ws = require("ws")
const fs = require("fs")
const { MessageModel } = require("./Model/Message.js")

const bcryptSalt = bcrypt.genSaltSync(10)
const app = express()
app.use(express.json())
app.use(cookieParser())
app.use(cors({
    credentials: true,
    origin: 'https://guileless-cactus-6fae53.netlify.app'
}))
app.use('/uploads', express.static(__dirname + "/uploads"))
dotenv.config()
mongoose.connect(process.env.MONGO_DB_URI)
const JWTSecret = process.env.JWT_SECRET;

async function getUserDataFromRequest(req) {
    return new Promise((resolve, reject) => {
        const token = req.cookies?.token;
        if (token) {
            jwt.verify(token, JWTSecret, {}, (err, userData) => {
                if (err) throw err;
                resolve(userData);
            });
        } else {
            reject('no token');
        }
    });

}

app.get('/messages/:userId', async (req, res) => {
    const { userId } = req.params;
    const userData = await getUserDataFromRequest(req)
    const ourUserId = userData.userId;
    const messages = await MessageModel.find({
        sender: { $in: [userId, ourUserId] },
        recipent: { $in: [userId, ourUserId] }
    }).sort({ createdAt: 1 })
        .exec()
    res.json(messages)
});

app.get("/profile", (req, res) => {
    const token = req.cookies?.token;
    if (token) {
        jwt.verify(token, JWTSecret, {}, (err, userData) => {
            if (err) {
                throw err
            }
            res.json(userData)
        })
    } else {
        res.status(401).json('no token')
    }
})

app.get("/people", async (req, res) => {
    const users = await UserModel.find({}, { '_id': 1, username: 1 });
    res.json(users)
})

app.post('/logout', (req, res) => {
    res.cookie('token', '', { sameSite: 'none', secure: true }).json('ok')
})

app.post("/register", async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashPassword = bcrypt.hashSync(password, bcryptSalt)
        const User = await UserModel.create({
            username,
            password: hashPassword
        })

        jwt.sign({ userId: User._id, username }, JWTSecret, {}, (err, token) => {
            if (err) throw err
            res.cookie('token', token, { sameSite: 'none', secure: true }).status(201).json({
                _id: User._id,
                username
            })
        })
    } catch (error) {
        if (error) throw error
    }
})

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const foundUser = await UserModel.findOne({ username })
    if (foundUser) {
        const passOk = bcrypt.compareSync(password, foundUser.password)
        if (passOk) {
            jwt.sign({ userId: foundUser._id, username }, JWTSecret, {}, (err, token) => {
                if (err) throw err
                res.cookie('token', token, { sameSite: 'none', secure: true }).status(201).json({
                    _id: foundUser._id,
                    username
                })
            })
        }
    } else {

    }
})

const server = app.listen(4000)


const wss = new ws.WebSocketServer({ server })
wss.on('connection', (connection, req) => {
    function notifyAboutOnlinePeople() {
        [...wss.clients].forEach(client => {
            client.send(JSON.stringify({
                online: [...wss.clients].map(c => ({ userId: c.userId, username: c.username }))
            }))
        });
    }
    connection.isAlive = true
    connection.timer = setInterval(() => {
        connection.ping()
        connection.deathTimer = setTimeout(() => {
            connection.isAlive = false;
            clearInterval(connection.timer)
            connection.terminate()
            notifyAboutOnlinePeople()
        }, 1000);
    }, 5000);

    connection.on('pong', () => {
        clearTimeout(connection.deathTimer)
    })

    const cookies = req.headers.cookie
    if (cookies) {
        const tokenCookieString = cookies.split(";").find(str => str.startsWith("token="))
        if (tokenCookieString) {
            const token = tokenCookieString.split("=")[1]
            if (token) {
                jwt.verify(token, JWTSecret, {}, (err, userData) => {
                    if (err) throw err
                    const { userId, username } = userData
                    connection.userId = userId
                    connection.username = username
                })
            }
        }
    }

    connection.on('message', async (message) => {
        const messageData = JSON.parse(message.toString())
        const { recipent, text, file } = messageData.message
        let filename = null
        if (file) {
            const parts = file.name.split('.');
            const ext = parts[parts.length - 1];
            filename = Date.now() + '.' + ext;
            const path = __dirname + '/uploads/' + filename;
            const bufferData = new Buffer(file.data.split(',')[1], 'base64')
            fs.writeFile(path, bufferData, () => {
                console.log('file saved');
            })
        }
        if (recipent && (text || file)) {
            const messageDoc = await MessageModel.create({
                sender: connection.userId,
                recipent: recipent,
                text,
                file: file ? filename : null
            });
            [...wss.clients]
                .filter(c => c.userId === recipent)
                .forEach(c => c.send(JSON.stringify({
                    text,
                    sender: connection.userId,
                    recipent,
                    file: file ? filename : null,
                    _id: messageDoc._id
                })))
        }
    });

    notifyAboutOnlinePeople()
})
