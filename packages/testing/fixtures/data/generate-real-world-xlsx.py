"""Regenerate the third-party XLSX fixtures used by the data-engine reader tests.

These workbooks come from independent writers so the in-house reader is not
only tested against its own output. Run from the repository root with an
interpreter that has the pinned writers installed, for example:

    python3 -m venv /tmp/xlsx-venv
    /tmp/xlsx-venv/bin/pip install openpyxl==3.1.5 xlsxwriter==3.3.1
    /tmp/xlsx-venv/bin/python -I packages/testing/fixtures/data/generate-real-world-xlsx.py

Outputs (next to this script): openpyxl.xlsx and xlsxwriter.xlsx.
"""

import datetime
import os
import sys

import openpyxl
import xlsxwriter

HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
FIXED = datetime.datetime(2024, 1, 1, 0, 0, 0)
HEADER = ["label", "amount", "day", "moment", "clock", "doubled"]
ROWS = [
    ("Ljubljana", 1.5, datetime.date(2024, 1, 2), datetime.datetime(2024, 1, 2, 3, 4, 5), datetime.time(12, 30)),
    ("Ljubljana", 2, datetime.date(1999, 12, 31), datetime.datetime(2000, 2, 29, 23, 59, 59), datetime.time(6, 0)),
]


def write_openpyxl(path):
    workbook = openpyxl.Workbook()
    workbook.properties.created = FIXED
    workbook.properties.modified = FIXED
    sheet = workbook.active
    sheet.title = "Data"
    sheet.append(HEADER)
    for index, (label, amount, day, moment, clock) in enumerate(ROWS, start=2):
        sheet.append([label, amount, day, moment, clock, f"=B{index}*2"])
        sheet.cell(index, 3).number_format = "yyyy-mm-dd"
        sheet.cell(index, 4).number_format = "yyyy-mm-dd hh:mm:ss"
        sheet.cell(index, 5).number_format = "hh:mm"
    hidden = workbook.create_sheet("Hidden")
    hidden.sheet_state = "hidden"
    hidden.append(["secret"])
    hidden.append([42])
    workbook.save(path)


def write_xlsxwriter(path):
    workbook = xlsxwriter.Workbook(path)
    workbook.set_properties({"created": FIXED})
    day = workbook.add_format({"num_format": "yyyy-mm-dd"})
    moment = workbook.add_format({"num_format": "yyyy-mm-dd hh:mm:ss"})
    clock = workbook.add_format({"num_format": "hh:mm"})
    bold = workbook.add_format({"bold": True})
    sheet = workbook.add_worksheet("Data")
    sheet.write_row(0, 0, HEADER)
    for row, (label, amount, day_value, moment_value, clock_value) in enumerate(ROWS, start=1):
        if row == 1:
            sheet.write_rich_string(row, 0, bold, "Ljub", "ljana")
        else:
            sheet.write_string(row, 0, label)
        sheet.write_number(row, 1, amount)
        sheet.write_datetime(row, 2, day_value, day)
        sheet.write_datetime(row, 3, moment_value, moment)
        sheet.write_datetime(row, 4, clock_value, clock)
        sheet.write_formula(row, 5, f"=B{row + 1}*2", None, amount * 2)
    hidden = workbook.add_worksheet("Hidden")
    hidden.hide()
    hidden.write_row(0, 0, ["secret"])
    hidden.write_row(1, 0, [42])
    workbook.close()


write_openpyxl(os.path.join(HERE, "openpyxl.xlsx"))
write_xlsxwriter(os.path.join(HERE, "xlsxwriter.xlsx"))
