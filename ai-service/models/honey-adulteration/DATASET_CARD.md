# Dataset card: honey adulteration (hyperspectral)

| Item | Value |
|---|---|
| Title | Hyperspectral Imaging adulterated honey dataset |
| Creators | Tessa Phillips, Bradley Coleman, Shunji Takano, Waleed Abdulla (University of Auckland), 2021 |
| DOI | 10.17608/k6.auckland.16441686.v1 |
| Licence | CC BY 4.0 (attribution required, as given above) |
| File used | `adulteration.csv` from <https://github.com/Esmael-Ahmed12/Adulteration>, the data repository of Ahmed E. (2024) *Detection of honey adulteration using machine learning*, PLOS Digital Health 3(6):e0000536. That paper states its data were derived from the Auckland dataset |
| SHA-256 of file used | `6a8243a7e61ba15c63f8c1c924f402d6b6d5eb97cbe27fe53a2ae403962f9754` (13,276,892 bytes) |
| Note on provenance | The figshare original (`adulteration_dataset_26_08_2021.csv`) is listed as 13,248,930 bytes; the GitHub copy is slightly larger. The figshare host was not reachable from the build machine, so byte-identity could not be checked. Both carry the same 128 bands and the label columns used here |
| Capture | SOC-710 hyperspectral imager, ~400–1000 nm; calibrated, pre-processed and segmented by the dataset authors |

## Contents (as inspected)

| Property | Value |
|---|---|
| Rows | 8,675 observations (segments); **0 missing values** |
| Columns | `Brand`, `Acquisition` (1–6), `Concentration_Class` (0/5/10/25/50/100), `Concentration` (measured %), 128 band columns `399.40nm` … `1063.79nm`, `Class` (botanical origin), `Adultration` (Yes/No) |
| Physical jars | 58 mixtures, identified by (Brand, Class, exact Concentration): 57 honey jars + 1 pure sugar-syrup reference |
| Observations per jar | usually 150 (6 acquisitions × 25 segments) |
| Honey products | 12 (Brand × Class), from 7 brands: Clover, Manuka (incl. UMF 5/10/15/20), ManukaBlend, BorageField, Kamahi, Rewarewa, MultiFloral |
| Rows used for training | 8,525 (the 150 pure-sugar rows are excluded because they are not honey) |

## Label definition used by HoneyChain

- `adulterated = 1` if `Concentration_Class > 0` (5, 10, 25 or 50 % sugar syrup), else `0`.
- The dataset's own **`Adultration` column is not used.** It is "Yes" only for the 50 % level and "No" for 5/10/25 % (and for pure syrup), which contradicts the measured concentrations.

## Class balance

| | Jars | Observations |
|---|---|---|
| Pure honey (0 %) | 7 | 1,050 |
| Adulterated (5–50 %) | 50 | 7,475 |

Only 7 of the 12 products have a pure jar. This is the main limitation of the evaluation.

## Grouping (leakage control)

All observations of one jar (and all jars of one product) stay on the same side of every split. The headline evaluation is **leave-one-product-out**: the model is tested only on honey products it never saw.
