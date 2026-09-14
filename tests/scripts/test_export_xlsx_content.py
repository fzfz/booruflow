from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


SCRIPT_DIR = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import export_xlsx_content  # noqa: E402


WORKBOOK_XML = """\
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="画风串" sheetId="1" r:id="rId1"/></sheets>
</workbook>
"""

WORKBOOK_RELS_XML = """\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
"""

SHARED_STRINGS_XML = """\
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>object</t></si><si><t>tag</t></si><si><t>例图</t></si>
  <si><t>alpha</t></si><si><t>first</t></si><si><t>second</t></si>
  <si><t>gamma</t></si>
</sst>
"""

SHEET_XML = """\
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c>
    </row>
    <row r="3"><c r="B3" t="s"><v>5</v></c></row>
    <row r="4"/>
    <row r="5"><c r="A5" t="s"><v>6</v></c></row>
  </sheetData>
</worksheet>
"""

SHEET_RELS_XML = """\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>
"""

DRAWING_XML = """\
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:row>1</xdr:row></xdr:from>
    <xdr:pic><xdr:blipFill><a:blip r:embed="rIdImage1"/></xdr:blipFill></xdr:pic>
  </xdr:oneCellAnchor>
  <xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:row>1</xdr:row></xdr:from>
    <xdr:pic><xdr:blipFill><a:blip r:embed="rIdImage2"/></xdr:blipFill></xdr:pic>
  </xdr:oneCellAnchor>
</xdr:wsDr>
"""

DRAWING_RELS_XML = """\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/first.bin"/>
  <Relationship Id="rIdImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/second.bin"/>
</Relationships>
"""


def make_fixture(path: Path) -> None:
    with ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", WORKBOOK_XML)
        archive.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS_XML)
        archive.writestr("xl/sharedStrings.xml", SHARED_STRINGS_XML)
        archive.writestr("xl/worksheets/sheet1.xml", SHEET_XML)
        archive.writestr("xl/worksheets/_rels/sheet1.xml.rels", SHEET_RELS_XML)
        archive.writestr("xl/drawings/drawing1.xml", DRAWING_XML)
        archive.writestr("xl/drawings/_rels/drawing1.xml.rels", DRAWING_RELS_XML)
        archive.writestr("xl/media/first.bin", b"\x89PNG\r\n\x1a\nfixture")
        archive.writestr("xl/media/second.bin", b"\xff\xd8\xfffixture")


class ExportXlsxContentTest(unittest.TestCase):
    def test_export_uses_data_row_order_and_keeps_anchored_images(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            workbook = root / "fixture.xlsx"
            output = root / "output"
            make_fixture(workbook)

            exported = export_xlsx_content.export_rows(
                workbook, output, "画风串", header_row_number=1, limit=0, overwrite=False
            )

            self.assertEqual(exported, 3)
            first = json.loads((output / "画风串_1" / "data.json").read_text(encoding="utf-8"))
            second = json.loads((output / "画风串_2" / "data.json").read_text(encoding="utf-8"))
            third = json.loads((output / "画风串_3" / "data.json").read_text(encoding="utf-8"))
            self.assertEqual(first["object"], "alpha")
            self.assertEqual(first["_source"]["data_row_order"], 1)
            self.assertEqual(first["_attachments"], ["1.png", "2.jpg"])
            self.assertEqual(second["_source"]["worksheet_row"], 3)
            self.assertIsNone(second["object"])
            self.assertEqual(third["object"], "gamma")

    def test_limit_and_error_branches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            workbook = root / "fixture.xlsx"
            make_fixture(workbook)

            self.assertEqual(
                export_xlsx_content.export_rows(
                    workbook, root / "limited", "画风串", header_row_number=1, limit=2, overwrite=False
                ),
                2,
            )
            with self.assertRaises(ValueError):
                export_xlsx_content.export_rows(
                    workbook, root / "negative", "画风串", header_row_number=1, limit=-1, overwrite=False
                )
            with self.assertRaises(ValueError):
                export_xlsx_content.export_rows(
                    workbook, root / "missing-sheet", "不存在", header_row_number=1, limit=1, overwrite=False
                )

    def test_random_sampling_supports_headerless_rows_and_seed_replay(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            workbook = root / "fixture.xlsx"
            make_fixture(workbook)

            first_output = root / "random-first"
            second_output = root / "random-second"
            first_count = export_xlsx_content.export_rows(
                workbook,
                first_output,
                "画风串",
                header_row_number=None,
                limit=0,
                overwrite=False,
                sample_size=2,
                seed=17,
            )
            second_count = export_xlsx_content.export_rows(
                workbook,
                second_output,
                "画风串",
                header_row_number=None,
                limit=0,
                overwrite=False,
                sample_size=2,
                seed=17,
            )

            self.assertEqual(first_count, 2)
            self.assertEqual(second_count, 2)
            first_directories = sorted(
                path.name for path in first_output.iterdir() if path.is_dir()
            )
            second_directories = sorted(
                path.name for path in second_output.iterdir() if path.is_dir()
            )
            self.assertEqual(first_directories, second_directories)
            first_rows = [
                json.loads((first_output / directory / "data.json").read_text(encoding="utf-8"))
                for directory in first_directories
            ]
            second_rows = [
                json.loads((second_output / directory / "data.json").read_text(encoding="utf-8"))
                for directory in second_directories
            ]
            self.assertEqual(first_rows, second_rows)
            self.assertTrue(all("column_A" in row for row in first_rows))
            self.assertTrue(
                all(
                    directory == f"画风串_{row['_source']['data_row_order']}"
                    for row, directory in zip(first_rows, first_directories)
                )
            )
            self.assertTrue(
                all(
                    row["_selection"] == {"method": "random", "sample_size": 2, "seed": 17}
                    for row in first_rows
                )
            )

    def test_existing_numbered_directory_requires_explicit_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            workbook = root / "fixture.xlsx"
            output = root / "output"
            make_fixture(workbook)
            (output / "画风串_1").mkdir(parents=True)

            with self.assertRaises(FileExistsError):
                export_xlsx_content.export_rows(
                    workbook, output, "画风串", header_row_number=1, limit=1, overwrite=False
                )
            (output / "画风串_999").mkdir()
            self.assertEqual(
                export_xlsx_content.export_rows(
                    workbook, output, "画风串", header_row_number=1, limit=1, overwrite=True
                ),
                1,
            )
            self.assertFalse((output / "画风串_999").exists())


if __name__ == "__main__":
    unittest.main()
