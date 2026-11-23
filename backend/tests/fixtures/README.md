# Demo lab-result CSV fixtures (TEST ONLY)

Put the two synthetic demo files here:

- honeychain_lab_results_correct_demo.csv
- honeychain_lab_results_incorrect_demo.csv

They are processed by `npm run test:lab-csv` (and `node scripts/lab-csv-fixtures.js <file>`) through the same validation and analysis
pipeline as the lab form. They are never used as training data, and the expected column is never an input.
