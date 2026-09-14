#!/usr/bin/env python3
"""Export worksheet rows and row-anchored images from an .xlsx file.

The workbook is treated as an untrusted data container. Cell text, worksheet
names, drawing metadata, and image bytes are read as data only; no workbook
text is interpreted as an instruction.

For each non-empty data row after the configured header row, the script creates
a directory named `<safe worksheet name>_<data row order>`, where the order is
the 1-based order within that worksheet after blank rows are skipped.
The directory contains:

    data.json
    1.png / 1.jpg / ...

The selected header row is used as the JSON field-name row unless
`--no-header` is supplied. The exported JSON keeps the row fields at the top
level and adds `_source`, `_attachments`, and `_selection` metadata for
traceability.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import random
import re
import shutil
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
DRAWING_MAIN_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

NS = {
    "main": MAIN_NS,
    "office_rel": OFFICE_REL_NS,
    "package_rel": PACKAGE_REL_NS,
    "drawing": DRAWING_NS,
    "drawing_main": DRAWING_MAIN_NS,
}


@dataclass(frozen=True)
class ImageAnchor:
    column: int
    media_path: str


@dataclass(frozen=True)
class Worksheet:
    name: str
    state: str
    path: str


@dataclass(frozen=True)
class SelectedRow:
    worksheet: str
    worksheet_row: int
    values: dict[int, object]
    header_names: dict[int, str]
    extra_field_names: dict[int, str]
    header_row_number: int | None
    data_row_order: int
    record_order: int
    anchors: tuple[ImageAnchor, ...]


def column_number(cell_reference: str) -> int:
    match = re.match(r"[A-Z]+", cell_reference)
    if match is None:
        raise ValueError(f"Invalid cell reference: {cell_reference}")
    number = 0
    for character in match.group(0):
        number = number * 26 + ord(character) - ord("A") + 1
    return number


def column_letters(column: int) -> str:
    if column < 1:
        raise ValueError(f"Column number must be positive: {column}")
    result = []
    while column:
        column, remainder = divmod(column - 1, 26)
        result.append(chr(ord("A") + remainder))
    return "".join(reversed(result))


def safe_path_component(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip()
    return cleaned or "worksheet"


def element_text(element: ET.Element | None) -> str:
    return "".join(element.itertext()) if element is not None else ""


def read_shared_strings(archive: ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [element_text(item) for item in root.findall("main:si", NS)]


def read_cell(cell: ET.Element, shared_strings: list[str]) -> object:
    cell_type = cell.attrib.get("t")
    value_element = cell.find("main:v", NS)

    if cell_type == "inlineStr":
        return element_text(cell.find("main:is", NS))
    if value_element is None:
        return None

    raw_value = value_element.text or ""
    if cell_type == "s":
        index = int(raw_value)
        if index >= len(shared_strings):
            raise ValueError(f"Shared-string index is out of range: {index}")
        return shared_strings[index]
    if cell_type == "b":
        return raw_value == "1"
    if cell_type == "str":
        return raw_value
    if cell_type == "e":
        return raw_value

    # Keep ordinary numeric values typed while leaving non-numeric values as
    # strings. Formula cells use their cached value, which is the only value
    # available without evaluating Excel formulas.
    try:
        if "." in raw_value or "e" in raw_value.lower():
            return float(raw_value)
        return int(raw_value)
    except ValueError:
        return raw_value


def read_rows(
    archive: ZipFile,
    worksheet_path: str,
    shared_strings: list[str],
) -> list[tuple[int, dict[int, object]]]:
    root = ET.fromstring(archive.read(worksheet_path))
    rows: list[tuple[int, dict[int, object]]] = []
    sheet_data = root.find("main:sheetData", NS)
    if sheet_data is None:
        return rows

    for row in sheet_data.findall("main:row", NS):
        row_number = int(row.attrib["r"])
        values: dict[int, object] = {}
        for cell in row.findall("main:c", NS):
            reference = cell.attrib.get("r")
            if reference is None:
                continue
            value = read_cell(cell, shared_strings)
            if value is not None:
                values[column_number(reference)] = value
        rows.append((row_number, values))
    return rows


def relationship_target(source_path: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_path), target))


def read_relationships(archive: ZipFile, source_path: str) -> dict[str, str]:
    relationship_path = posixpath.join(
        posixpath.dirname(source_path),
        "_rels",
        f"{posixpath.basename(source_path)}.rels",
    )
    try:
        root = ET.fromstring(archive.read(relationship_path))
    except KeyError:
        return {}
    return {
        relationship.attrib["Id"]: relationship_target(
            source_path, relationship.attrib["Target"]
        )
        for relationship in root.findall("package_rel:Relationship", NS)
    }


def read_image_anchors(archive: ZipFile, worksheet_path: str) -> dict[int, list[ImageAnchor]]:
    worksheet_relationships = read_relationships(archive, worksheet_path)
    drawing_path = None
    for target in worksheet_relationships.values():
        if target.startswith("xl/drawings/") and target.endswith(".xml"):
            drawing_path = target
            break
    if drawing_path is None:
        return {}

    drawing_relationships = read_relationships(archive, drawing_path)
    try:
        root = ET.fromstring(archive.read(drawing_path))
    except KeyError:
        return {}

    result: dict[int, list[ImageAnchor]] = {}
    for anchor in list(root):
        from_cell = anchor.find("drawing:from", NS)
        blip = anchor.find(".//drawing_main:blip", NS)
        if from_cell is None or blip is None:
            continue
        row_element = from_cell.find("drawing:row", NS)
        column_element = from_cell.find("drawing:col", NS)
        relationship_id = blip.attrib.get(f"{{{OFFICE_REL_NS}}}embed")
        if row_element is None or column_element is None or relationship_id is None:
            continue
        media_path = drawing_relationships.get(relationship_id)
        if media_path is None:
            continue
        row_number = int(row_element.text or "0") + 1
        column = int(column_element.text or "0") + 1
        result.setdefault(row_number, []).append(ImageAnchor(column, media_path))
    return result


def image_extension(data: bytes, source_path: str) -> str:
    signatures = (
        (b"\x89PNG\r\n\x1a\n", ".png"),
        (b"\xff\xd8\xff", ".jpg"),
        (b"GIF87a", ".gif"),
        (b"GIF89a", ".gif"),
        (b"RIFF", ".webp"),
        (b"BM", ".bmp"),
        (b"II*\x00", ".tif"),
        (b"MM\x00*", ".tif"),
    )
    for signature, extension in signatures:
        if data.startswith(signature):
            return extension
    extension = Path(source_path).suffix.lower()
    return extension if extension in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"} else ".bin"


def unique_field_name(name: str, used_names: set[str]) -> str:
    base_name = name or "column"
    candidate = base_name
    suffix = 2
    while candidate in used_names:
        candidate = f"{base_name}_{suffix}"
        suffix += 1
    used_names.add(candidate)
    return candidate


def read_worksheets(archive: ZipFile) -> list[Worksheet]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    workbook_relationships = read_relationships(archive, "xl/workbook.xml")
    worksheets: list[Worksheet] = []
    for sheet in workbook.findall("main:sheets/main:sheet", NS):
        relationship_id = sheet.attrib.get(f"{{{OFFICE_REL_NS}}}id")
        if relationship_id is None:
            raise ValueError(f"Worksheet has no relationship: {sheet.attrib.get('name', '')}")
        worksheet_path = workbook_relationships.get(relationship_id)
        if worksheet_path is None:
            raise ValueError(f"Worksheet relationship target is missing: {sheet.attrib.get('name', '')}")
        worksheets.append(
            Worksheet(
                name=sheet.attrib.get("name", ""),
                state=sheet.attrib.get("state", "visible"),
                path=worksheet_path,
            )
        )
    return worksheets


def select_worksheets(
    worksheets: list[Worksheet],
    sheet_name: str | None,
    include_hidden: bool,
) -> list[Worksheet]:
    if sheet_name is not None:
        selected = [worksheet for worksheet in worksheets if worksheet.name == sheet_name]
        if selected:
            return selected
        available = [worksheet.name for worksheet in worksheets]
        raise ValueError(
            f"Worksheet not found: {sheet_name}; available worksheets: {available}"
        )

    selected = [
        worksheet
        for worksheet in worksheets
        if include_hidden or worksheet.state == "visible"
    ]
    if not selected:
        raise ValueError("Workbook has no selectable worksheets")
    return selected


def make_field_names(
    rows: list[tuple[int, dict[int, object]]],
    header_position: int | None,
) -> tuple[dict[int, str], dict[int, str]]:
    header_names: dict[int, str] = {}
    used_names: set[str] = set()
    if header_position is not None:
        for column, value in sorted(rows[header_position][1].items()):
            header_names[column] = unique_field_name(str(value), used_names)

    data_rows = rows if header_position is None else rows[header_position + 1 :]
    extra_field_names = {
        column: unique_field_name(f"column_{column_letters(column)}", used_names)
        for column in sorted(
            {
                column
                for _, values in data_rows
                for column in values
                if column not in header_names
            }
        )
    }
    return header_names, extra_field_names


def collect_worksheet_rows(
    archive: ZipFile,
    worksheet: Worksheet,
    header_row_number: int | None,
) -> list[SelectedRow]:
    shared_strings = read_shared_strings(archive)
    rows = read_rows(archive, worksheet.path, shared_strings)
    image_rows = read_image_anchors(archive, worksheet.path)
    if not rows:
        return []

    header_position: int | None = None
    if header_row_number is not None:
        header_position = next(
            (
                position
                for position, (row_number, _values) in enumerate(rows)
                if row_number == header_row_number
            ),
            None,
        )
        if header_position is None:
            raise ValueError(
                f"Header row does not exist: {header_row_number}; worksheet: {worksheet.name}"
            )

    header_names, extra_field_names = make_field_names(rows, header_position)
    data_rows = rows if header_position is None else rows[header_position + 1 :]
    result: list[SelectedRow] = []
    data_row_order = 0
    for row_number, values in data_rows:
        anchors = tuple(
            sorted(image_rows.get(row_number, []), key=lambda item: item.column)
        )
        if not row_is_data(values, list(anchors)):
            continue
        data_row_order += 1
        result.append(
            SelectedRow(
                worksheet=worksheet.name,
                worksheet_row=row_number,
                values=values,
                header_names=header_names,
                extra_field_names=extra_field_names,
                header_row_number=header_row_number,
                data_row_order=data_row_order,
                record_order=0,
                anchors=anchors,
            )
        )
    return result


def row_is_data(values: dict[int, object], images: list[ImageAnchor]) -> bool:
    return bool(values) or bool(images)


def export_rows(
    xlsx_path: Path,
    output_dir: Path,
    sheet_name: str | None,
    header_row_number: int | None,
    limit: int,
    overwrite: bool,
    sample_size: int = 0,
    seed: int | None = None,
    include_hidden: bool = False,
) -> int:
    if limit < 0:
        raise ValueError("--limit must be zero or a positive integer")
    if sample_size < 0:
        raise ValueError("--sample-size must be zero or a positive integer")
    if limit and sample_size:
        raise ValueError("--limit and --sample-size cannot be used together")
    if seed is not None and not sample_size:
        raise ValueError("--seed requires --sample-size")
    if header_row_number is not None and header_row_number < 1:
        raise ValueError("--header-row must be a positive integer")
    if not xlsx_path.is_file():
        raise FileNotFoundError(f"Input workbook does not exist: {xlsx_path}")

    with ZipFile(xlsx_path) as archive:
        worksheets = select_worksheets(
            read_worksheets(archive), sheet_name, include_hidden
        )
        rows = [
            row
            for worksheet in worksheets
            for row in collect_worksheet_rows(archive, worksheet, header_row_number)
        ]
        rows = [
            replace(row, record_order=record_order)
            for record_order, row in enumerate(rows, start=1)
        ]
        worksheet_prefixes = {
            safe_path_component(worksheet.name) for worksheet in worksheets
        }
        if sample_size:
            if sample_size > len(rows):
                raise ValueError(
                    f"Random sample size {sample_size} exceeds available data rows {len(rows)}"
                )
            selected_rows = random.Random(seed).sample(rows, sample_size)
            selection = {
                "method": "random",
                "sample_size": sample_size,
                "seed": seed,
            }
        elif limit:
            selected_rows = rows[:limit]
            selection = {"method": "ordered", "limit": limit}
        else:
            selected_rows = rows
            selection = {"method": "ordered", "limit": 0}

        output_dir.mkdir(parents=True, exist_ok=True)
        if overwrite:
            for child in output_dir.iterdir():
                is_old_numeric_directory = child.name.isdigit()
                is_selected_worksheet_directory = any(
                    child.name.startswith(f"{prefix}_")
                    and child.name[len(prefix) + 1 :].isdigit()
                    for prefix in worksheet_prefixes
                )
                if child.is_dir() and (
                    is_old_numeric_directory or is_selected_worksheet_directory
                ):
                    shutil.rmtree(child)
        for export_order, selected_row in enumerate(selected_rows, start=1):
            directory_name = (
                f"{safe_path_component(selected_row.worksheet)}"
                f"_{selected_row.data_row_order}"
            )
            row_dir = output_dir / directory_name
            if row_dir.exists():
                if not overwrite:
                    raise FileExistsError(
                        f"Output directory already exists: {row_dir}; use --overwrite to replace it"
                    )
                if not row_dir.is_dir():
                    raise FileExistsError(f"Output path is not a directory: {row_dir}")
                shutil.rmtree(row_dir)
            row_dir.mkdir(parents=False)

            record: dict[str, object] = {}
            for column, field_name in selected_row.header_names.items():
                record[field_name] = selected_row.values.get(column)
            for column, value in sorted(selected_row.values.items()):
                if column not in selected_row.header_names:
                    record[selected_row.extra_field_names[column]] = value

            attachment_names: list[str] = []
            for image_index, anchor in enumerate(selected_row.anchors, start=1):
                image_data = archive.read(anchor.media_path)
                extension = image_extension(image_data, anchor.media_path)
                image_name = f"{image_index}{extension}"
                (row_dir / image_name).write_bytes(image_data)
                attachment_names.append(image_name)

            record["_source"] = {
                "worksheet": selected_row.worksheet,
                "header_row": selected_row.header_row_number,
                "worksheet_row": selected_row.worksheet_row,
                "data_row_order": selected_row.data_row_order,
                "record_order": selected_row.record_order,
                "export_order": export_order,
                "directory_name": directory_name,
            }
            record["_attachments"] = attachment_names
            record["_selection"] = selection
            (row_dir / "data.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

        return len(selected_rows)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export worksheet rows and row-anchored images from an .xlsx workbook."
    )
    parser.add_argument("xlsx_path", type=Path, help="Path to the source .xlsx workbook")
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Output directory for row folders",
    )
    parser.add_argument(
        "--sheet",
        help="Worksheet name to export; omit to use all visible worksheets",
    )
    parser.add_argument(
        "--include-hidden",
        action="store_true",
        help="Include hidden worksheets when --sheet is omitted",
    )
    header_group = parser.add_mutually_exclusive_group()
    header_group.add_argument(
        "--header-row",
        type=int,
        default=1,
        help="1-based worksheet row containing JSON field names (default: 1)",
    )
    header_group.add_argument(
        "--no-header",
        action="store_true",
        help="Treat every worksheet row as data and generate column_A, column_B, ... fields",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Maximum number of data rows; 0 exports all data rows (default: 0)",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=0,
        help="Randomly select this many data rows; 0 disables random sampling (default: 0)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        help="Random sampling seed; requires --sample-size",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing row output directories for the selected worksheets",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        exported = export_rows(
            xlsx_path=args.xlsx_path,
            output_dir=args.output_dir,
            sheet_name=args.sheet,
            header_row_number=None if args.no_header else args.header_row,
            limit=args.limit,
            overwrite=args.overwrite,
            sample_size=args.sample_size,
            seed=args.seed,
            include_hidden=args.include_hidden,
        )
    except (ET.ParseError, KeyError, OSError, ValueError, FileExistsError) as error:
        print(f"导出失败：{error}", file=sys.stderr)
        return 1
    print(f"已由脚本导出 {exported} 条数据行到：{args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
