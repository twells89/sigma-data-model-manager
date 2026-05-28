# Synthetic QUICKSIGHT_JSON .qs bundle layout

Per AWS docs (assetbundle-export.html and the Business Intelligence blog "Automate and accelerate your Amazon QuickSight asset deployments"), the export is a single zip with `.qs` extension. Each asset type lives in its own top-level folder; each file is `<resourceId>.json`. No manifest at the root.

```
my-dashboard-bundle.qs   (zip)
├── analyses/
│   └── 5fa1...a7b3.json            # analysisId
├── dashboards/
│   └── sales-overview.json         # dashboardId
├── datasets/
│   ├── orders-with-customers.json  # dataSetId
│   └── customers.json
├── datasources/
│   └── redshift-prod.json          # dataSourceId
├── themes/
│   └── corporate-theme.json
├── refresh-schedules/              # only when --include-all-dependencies
│   └── orders-with-customers__hourly.json
└── vpc-connections/                # optional
    └── vpc-prod.json
```

Each `analyses/<id>.json` contains the same `Definition` shape as `DescribeAnalysisDefinition.Definition` (top keys: `DataSetIdentifierDeclarations`, `AnalysisDefaults`, `CalculatedFields`, `ColumnConfigurations`, `FilterGroups`, `Options`, `ParameterDeclarations`, `Sheets`). Each `datasets/<id>.json` is the `DataSet` shape (PhysicalTableMap, LogicalTableMap, OutputColumns, ImportMode, ...).

Note: AWS also offers `CLOUDFORMATION_JSON` export — that one is a single JSON file (CFN template), not a folder zip.
