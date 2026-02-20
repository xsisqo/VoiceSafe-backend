const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Root endpoint
app.get('/', (req, res) => {
    res.send('VoiceSafe backend is running!');
});

// Nastavenie ukladania súborov
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// Endpoint pre upload súboru
app.post('/upload', upload.single('audio'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'No file uploaded' });
    }
    console.log('File uploaded:', req.file.filename);
    res.json({ status: 'success', message: 'File uploaded', filename: req.file.filename });
});

// Endpoint pre zoznam súborov
app.get('/files', (req, res) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) return res.json({ files: [] });
    const files = fs.readdirSync(uploadDir);
    res.json({ files });
});

// Endpoint pre stiahnutie súboru
app.get('/files/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ status: 'error', message: 'File not found' });
    res.download(filePath);
});

// Spustenie servera
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));