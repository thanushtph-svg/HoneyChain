
from flask import Flask, render_template, jsonify, request, redirect
import io
from flask import send_file
import qrcode

app = Flask(__name__, static_folder="../static", template_folder="../templates")

BOTTLES = {
    "HC-KVIC-2026-0827-001": {
        "bottle": "Bottle 01", "honey": "Multifloral Honey", "producer": "Shakti Rural Beekeepers Cooperative",
        "beekeeper": "Lakshmi Devi", "hive": "HIVE-KA-047", "origin": "Chikkaballapur, Karnataka",
        "harvest": "27 Aug 2026", "time": "06:42 AM", "quantity": "500 g",
        "health": 92, "temp": "34.2 °C", "humidity": "68 %", "yield": "8.4 kg",
        "lab": {"sample":"HC-LAB-0828-047-A","moisture":"17.8 %","hmf":"9.6 mg/kg","sucrose":"3.1 %","pollen":"Multifloral detected","adulteration":"Not detected","result":"PASSED"},
        "journey":[
            ["🐝","Harvest","Chikkaballapur","27 Aug • 06:42 AM","34.2 °C","0x82A7C19F...91F"],
            ["📦","Collection Centre","Chikkaballapur Hub","27 Aug • 10:15 AM","31.8 °C","0x71B4D820...32C"],
            ["🧪","Laboratory","Bengaluru Honey Quality Lab","28 Aug • 02:30 PM","24.1 °C","0xA91F621D...72D"],
            ["🏭","Packaging","Bengaluru Processing Zone","29 Aug • 09:20 AM","23.4 °C","0x42F918AC...18A"],
            ["🚚","Distribution","Bengaluru Logistics Hub","30 Aug • 04:45 PM","22.8 °C","0xC21B750E...65B"],
            ["🏪","Retailer","Bengaluru Retail Store","31 Aug • 11:10 AM","22.4 °C","0x93D118FE...10E"]
        ]
    },
    "HC-KVIC-2026-0827-002": {
        "bottle": "Bottle 02", "honey": "Eucalyptus Honey", "producer": "Malnad Bee Collective",
        "beekeeper": "Ramesh Gowda", "hive": "HIVE-KA-112", "origin": "Hassan, Karnataka",
        "harvest": "26 Aug 2026", "time": "07:18 AM", "quantity": "500 g",
        "health": 88, "temp": "33.6 °C", "humidity": "64 %", "yield": "7.9 kg",
        "lab": {"sample":"HC-LAB-0827-112-B","moisture":"18.2 %","hmf":"11.4 mg/kg","sucrose":"2.8 %","pollen":"Eucalyptus detected","adulteration":"Not detected","result":"PASSED"},
        "journey":[
            ["🐝","Harvest","Hassan, Karnataka","26 Aug • 07:18 AM","33.6 °C","0x51D7A220...A12"],
            ["📦","Collection Centre","Hassan Rural Hub","26 Aug • 11:02 AM","30.7 °C","0x44B9C712...E31"],
            ["🧪","Laboratory","Mysuru Honey Quality Lab","27 Aug • 01:45 PM","23.8 °C","0x7AC82D10...B74"],
            ["🏭","Packaging","Mysuru Food Park","28 Aug • 10:05 AM","23.1 °C","0x92F31E8C...C20"],
            ["🚚","Distribution","Bengaluru Logistics Hub","29 Aug • 05:12 PM","22.6 °C","0x38A1D904...D88"],
            ["🏪","Retailer","Bengaluru Retail Store","30 Aug • 12:25 PM","22.2 °C","0x61E7BC20...F19"]
        ]
    },
    "HC-KVIC-2026-0827-003": {
        "bottle": "Bottle 03", "honey": "Jamun Honey", "producer": "Namma Bee Farmers Group",
        "beekeeper": "Anitha Rao", "hive": "HIVE-KA-208", "origin": "Kolar, Karnataka",
        "harvest": "25 Aug 2026", "time": "06:55 AM", "quantity": "500 g",
        "health": 95, "temp": "32.9 °C", "humidity": "61 %", "yield": "9.1 kg",
        "lab": {"sample":"HC-LAB-0826-208-C","moisture":"17.1 %","hmf":"8.2 mg/kg","sucrose":"2.4 %","pollen":"Jamun pollen detected","adulteration":"Not detected","result":"PASSED"},
        "journey":[
            ["🐝","Harvest","Kolar, Karnataka","25 Aug • 06:55 AM","32.9 °C","0xB27D8120...A55"],
            ["📦","Collection Centre","Kolar Collection Hub","25 Aug • 10:40 AM","30.2 °C","0xE19A731C...D61"],
            ["🧪","Laboratory","Bengaluru Honey Quality Lab","26 Aug • 03:05 PM","23.9 °C","0xD82F41AA...C92"],
            ["🏭","Packaging","Bengaluru Processing Zone","27 Aug • 09:45 AM","23.2 °C","0x71C9E20B...F48"],
            ["🚚","Distribution","Bengaluru Logistics Hub","28 Aug • 04:10 PM","22.5 °C","0xA91B620D...B73"],
            ["🏪","Retailer","Bengaluru Retail Store","29 Aug • 11:35 AM","22.1 °C","0xC31E750F...E06"]
        ]
    }
}

@app.route("/")
def home():
    return render_template("home.html", bottles=BOTTLES)

@app.route("/verify/<batch>")
def verify(batch):
    bottle = BOTTLES.get(batch.upper())
    if not bottle:
        return render_template("not_found.html", batch=batch), 404
    return render_template("verify.html", batch=batch.upper(), b=bottle)

@app.route("/qr/<batch>")
def qr(batch):
    if batch.upper() not in BOTTLES:
        return jsonify({"error":"Unknown batch"}), 404
    url = request.url_root.rstrip("/") + "/verify/" + batch.upper()
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png", download_name=f"{batch}.png")

@app.route("/api/batch/<batch>")
def api_batch(batch):
    b = BOTTLES.get(batch.upper())
    if not b: return jsonify({"error":"Unknown batch"}),404
    return jsonify(b)

@app.route("/api/batches")
def api_batches():
    return jsonify(BOTTLES)

# Vercel imports this WSGI app.
application = app
