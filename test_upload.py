import requests

url = "https://voicesafe-backend-1.onrender.com/upload"
file_path = "test.mp3"  # tvoj audio súbor

with open(file_path, "rb") as f:
    files = {"audio": f}
    response = requests.post(url, files=files)

print("Status:", response.status_code)
print("Response:", response.text)