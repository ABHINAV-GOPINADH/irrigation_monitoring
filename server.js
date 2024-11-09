const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');
const session = require('express-session');

// AWS WebSocket API URL
const awsWebSocketUrl = 'use-your-aws-web-socket-url';

let wsClient;

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

const port = 5000;

// Set up EJS view engine
app.set("view engine", "ejs");

// MongoDB connection URI
const uri = process.env.MONGODB_URI || 'your-mongoDB-user-url';

// Set up session
app.use(session({
    secret: 'jemetunephraseenfrancaisquepersonnenecomprend',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 600000 } // Session expires after 1 hour
}));

// Mongoose Schema for Sensors
const sensorSchema = new mongoose.Schema({
    time: { type: String, required: true },
    temperature: { type: Number, required: true },
    humidity: { type: Number, required: true },
    soilMoisture: { type: Number, default: 0 } // Or set to `null` if you want it unset
});

// Mongoose Schema for Motor
const motorSchema = new mongoose.Schema({
    duration: { type: Number, required: true }, // Duration in seconds
    status: { type: String, required: true },   // ON or OFF
    timestamp: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

// Mongoose Models for Sensors and Motor Data and User
const User = mongoose.model('User', userSchema);
const SensorData = mongoose.model('SensorData', sensorSchema);
const MotorData = mongoose.model('MotorData', motorSchema);

// Function to connect to the AWS WebSocket API
function connectWebSocket() {
    wsClient = new WebSocket(awsWebSocketUrl);

    // Connection opened
    wsClient.on('open', function open() {
        console.log('Connected to AWS WebSocket API');
    });

    wsClient.on('message', async (data) => {
        try {
            const jsonData = JSON.parse(data); // Parse JSON data
    
            // Check for missing or invalid fields and cast to numbers if necessary
            const { temperature, humidity, soilMoisture } = jsonData;
    
            if (
                isNaN(Number(temperature)) || 
                isNaN(Number(humidity)) || 
                isNaN(Number(soilMoisture))
            ) {
                console.error('Received data with invalid numeric fields:', jsonData);
                return;
            }
    
            // Create a new sensor data record with validated and casted numbers
            const newSensorData = new SensorData({
                time: new Date().toISOString(),
                temperature: Number(temperature),
                humidity: Number(humidity),
                soilMoisture: Number(soilMoisture),
            });
    
            // Save to MongoDB
            await newSensorData.save();
            console.log('Sensor data saved successfully from WebSocket:', jsonData);
    
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    });    

    // Handle connection close
    wsClient.on('close', function close() {
        console.log('WebSocket connection closed. Reconnecting...');
        setTimeout(connectWebSocket, 5000); // Retry after 5 seconds
    });

    // Handle connection errors
    wsClient.on('error', function error(err) {
        console.error('WebSocket error:', err);
        wsClient.close();
    });
}
// Call this function to establish the WebSocket connection
connectWebSocket();

// Authentication middleware
function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.redirect('/login');
}

// Login route
app.get('/login', (req, res) => {
    res.render('login');
});

// Route for Home Page
app.get("/",  isAuthenticated,async (req, res) => {
    try {
        const sensorDataArray = await SensorData.find({}).exec();
        res.render("login", { sensorData: sensorDataArray });
    } catch (error) {
        console.error('Error fetching sensor data:', error);
        res.status(500).send('Error fetching sensor data');
    }
});

//ROute for test page
app.get('/test', isAuthenticated, async (req, res) => {
    try {
        const motorDataArray = await MotorData.find({}).exec();
        const sensorDataArray = await SensorData.find({}).exec();
        res.render("test", { sensorData: sensorDataArray, motors: motorDataArray });
    } catch (error) {
        console.error('Error fetching sensor data:', error);
        res.status(500).send('Error fetching sensor data');
    }
});
// Route for Pump Control Page
app.get("/display", isAuthenticated, async (req, res) => {
    try {
        const sensorDataArray = await SensorData
        .find({}).exec();
        res.render("display", { sensorData: sensorDataArray });
    } catch (error) {
        console.error('Error fetching sensor data:', error);
        res.status(500).send('Error fetching sensor data');
    }
});

// Route for Pump Control Page
app.get("/pump", isAuthenticated, async (req, res) => {
    try {
        const sensorDataArray = await SensorData.find({}).exec();
        res.render("pump", { sensorData: sensorDataArray });
    } catch (error) {
        console.error('Error fetching sensor data:', error);
        res.status(500).send('Error fetching sensor data');
    }
});
app.get("/motor", isAuthenticated, async (req, res) => {
    try {
        const sensorDataArray = await SensorData.find({}).exec();
        res.render("motor", { sensorData: sensorDataArray });
        
    } catch (error) {
        console.error('Error fetching sensor data:', error);
        res.status(500).send('Error fetching sensor data');
    }
});


// Route to Add Sensor Data
app.post("/addData", async (req, res) => {
    try {
        console.log("Request received with data: ", req.body);

        // Check for missing or invalid data
        if (!req.body.temperature || !req.body.humidity || !req.body.soilMoisture) {
            return res.status(400).send('Missing required fields');
        }

        // Create a new sensor data record
        const newSensorData = new SensorData({
            time: new Date().toISOString(),
            temperature: req.body.temperature,
            humidity: req.body.humidity,
            soilMoisture: req.body.soilMoisture
        });

        // Save to MongoDB
        await newSensorData.save();
        console.log('Sensor data saved successfully');
        res.json({ message: 'Data saved successfully' });
    } catch (error) {
        console.error('Error saving sensor data:', error);
        res.status(500).send('Error saving sensor data');
    }
});


// Route to Activate Pump and Add Motor Data
app.post("/activatePump", async (req, res) => {
    const { duration, status } = req.body;

    const newMotorData = new MotorData({
        duration: parseInt(duration),
        status: status,
    });

    try {
        await newMotorData.save();

        // Send motor data to WebSocket
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            const motorData = JSON.stringify({ 
                action:"sendPumpData",
                duration: newMotorData.duration, 
                status: newMotorData.status 
            });
            wsClient.send(motorData);
            console.log('Motor data sent to WebSocket:', motorData);
        } else {
            console.error('WebSocket is not connected');
        }

        const motorDataArray = await MotorData.find({}).exec();
        res.render("motor", { motors: motorDataArray });
    } catch (error) {
        console.error('Error saving motor data:', error);
        res.status(500).send('Error saving motor data');
    }
});

// Handle POST request for login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Trouver l'utilisateur dans la base de données
        const user = await User.findOne({ username });
        // Vérifier si l'utilisateur existe et comparer les mots de passe
        if (user && await bcrypt.compare(password, user.password)) {
            
            req.session.user = user; // Stocker l'utilisateur dans la session
            
            res.redirect('/test'); // Rediriger vers la page de test
        } else {
            // Délai de 1 seconde avant de rediriger
            setTimeout(() => {
                res.redirect('/login'); // Rediriger vers la page de connexion si l'authentification échoue
            }, 1000); // 1000 ms = 1 seconde
        }
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/'); // Handle error if necessary
        }
        res.redirect('/login'); // Redirect to login after session is destroyed
    });
});

// Start the server and connect to MongoDB
mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => {
        console.log('Connected to MongoDB via Mongoose');
        app.listen(port, () => {
            console.log(`Server is listening at http://localhost:${port}`);
        });
    })
    .catch(err => {
        console.error('Error connecting to MongoDB', err);
        process.exit(1);
    });
