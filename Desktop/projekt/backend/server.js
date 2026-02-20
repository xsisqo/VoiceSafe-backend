const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

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

// Spustenie servera
const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));