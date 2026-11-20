"""Download the public hyperspectral honey-adulteration dataset.

Source chain (both CC BY 4.0):
  Phillips T., Coleman B., Takano S., Abdulla W. (2021) "Hyperspectral Imaging adulterated
  honey dataset", University of Auckland, doi:10.17608/k6.auckland.16441686.v1
  -> redistributed as adulteration.csv in the data repository of
  Ahmed E. (2024) "Detection of honey adulteration using machine learning",
  PLOS Digital Health 3(6):e0000536, https://github.com/Esmael-Ahmed12/Adulteration

Usage (from ai-service/):   python training/download_data.py
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/Esmael-Ahmed12/Adulteration/main/adulteration.csv"
OUT = Path(__file__).resolve().parent.parent / "data" / "raw" / "adulteration.csv"


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists() and "--force" not in sys.argv:
        print(f"Already present: {OUT} (use --force to re-download)")
    else:
        print(f"Downloading {URL} ...")
        urllib.request.urlretrieve(URL, OUT)
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    print(f"Saved {OUT} ({OUT.stat().st_size:,} bytes) sha256={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
