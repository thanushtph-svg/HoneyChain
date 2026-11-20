# Datasets

Raw data files are **not** committed (`data/raw/` is git-ignored). Download them with the scripts.

## Adulteration (hyperspectral) - used

```powershell
python training/download_data.py
```

Downloads `adulteration.csv` from https://github.com/Esmael-Ahmed12/Adulteration (data of Ahmed 2024, derived from Phillips et al. 2021, University of Auckland, doi:10.17608/k6.auckland.16441686.v1, **CC BY 4.0**). Expected SHA-256: `6a8243a7e61ba15c63f8c1c924f402d6b6d5eb97cbe27fe53a2ae403962f9754`.

You may instead download the original from figshare (`adulteration_dataset_26_08_2021.csv`) and save it as `data/raw/adulteration.csv`. The training script only needs the columns `Brand, Class, Concentration_Class, Concentration, Acquisition` and the 128 `...nm` band columns.

**Do not use** the separate *"Hyperspectral imaging generated adulterated honey dataset"* (figshare 19134698): it is VAE-generated synthetic data, not ground truth.

## Quality (lab measurements) - not available

Investigated: Aykas D.P. (2023) *Foods* 12(3):523. Its data-availability statement says "Data is contained within the article", but the article contains only summary statistics (min/max/mean/SD), with no per-sample table, no supplementary data, and no quality-grade labels. A model cannot honestly be trained from it.

To enable the quality model, supply a CSV with one row per sample:

| Column | Unit |
|---|---|
| `moisture_pct` | % |
| `hmf_mg_kg` | mg/kg |
| `sucrose_g_100g`, `glucose_g_100g`, `fructose_g_100g` | g/100 g |
| `brix` | °Brix |
| `ph` | - |
| `free_acidity_meq_kg` | meq/kg |
| `water_activity` | aw |
| `electrical_conductivity_ms_cm` | mS/cm |
| `<label>` | a real, documented ground-truth label (e.g. an expert grade) or numeric target |
| `<group>` | sample / producer id, so related rows never span train and test |

At least 3 feature columns and 60 rows are required. Labels derived purely from regulatory thresholds would only re-learn the rule-based screening, so don't use them.
