"""使用真实渲染器和事件委托验证网格交互；测试数据由 grid-fixture.mjs 提供。"""
import argparse
import csv
import io
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

PAGE_ROWS = 100
SELECTED_ROW = 2
FROZEN_ROWS = SELECTED_ROW + 1
FROZEN_COLUMNS = 2
SCROLL_X = 370
SCROLL_Y = 430
RESIZE_DELTA = 80
POSITION_TOLERANCE = 1.5
VIEWPORT = {"width": 1080, "height": 760}
MYSQL_QUOTE = "\x60"
MULTI_ROWS = [1, 4, 6]
MULTI_CLICK_ORDER = [6, 1, 4]


def row_cell(page, row_index, column_index=0):
    return page.locator("table.grid tbody tr").nth(row_index).locator("td").nth(column_index)


def open_row_menu(page, row_index):
    row_cell(page, row_index).click(button="right")
    expect(page.locator("#gridContextMenu")).to_be_visible()


def menu_click(page, label):
    page.get_by_role("menuitem", name=label, exact=True).click()
    expect(page.locator("#gridContextMenu")).to_be_hidden()


def clipboard(page):
    return page.evaluate("navigator.clipboard.readText()")


def copy_row(page, row_index, format_name):
    open_row_menu(page, row_index)
    menu_click(page, "复制整行为 " + format_name)
    expect(page.locator("#fixtureToast")).to_have_text("整行已复制为 " + format_name)
    return clipboard(page)


def assert_position(actual, expected):
    assert abs(actual - expected) <= POSITION_TOLERANCE, (actual, expected)


def assert_selected(page, expected):
    actual = page.locator("table.grid tbody tr.row-selected").evaluate_all("rows => rows.map(row => Number(row.dataset.ri))")
    assert actual == expected, (actual, expected)
    expect(page.locator("table.grid")).to_have_attribute("data-selected-count", str(len(expected)))
    expect(page.locator('table.grid tbody tr[aria-selected="true"]')).to_have_count(len(expected))
    if len(expected) > 1:
        expect(page.locator("#sbCell")).to_have_text(f"已选 {len(expected)} 行")


def select_rows(page, indices):
    row_cell(page, indices[0]).click()
    for index in indices[1:]:
        row_cell(page, index).click(modifiers=["Control"])


def copy_rows(page, format_name):
    open_row_menu(page, MULTI_ROWS[0])
    assert_selected(page, MULTI_ROWS)
    menu_click(page, f"复制所选 {len(MULTI_ROWS)} 行为 {format_name}")
    expect(page.locator("#fixtureToast")).to_have_text(f"已复制 {len(MULTI_ROWS)} 行为 {format_name}")
    return clipboard(page)


def wait_clipboard(page, text):
    page.wait_for_function("expected => navigator.clipboard.readText().then(text => text === expected)", arg=text)


def test_modifier_selection(page):
    row_cell(page, 2, 2).click()
    row_cell(page, 6, 2).click(modifiers=["Shift"])
    assert_selected(page, [2, 3, 4, 5, 6])
    row_cell(page, 4).click(modifiers=["Shift"])
    assert_selected(page, [2, 3, 4])
    row_cell(page, 0).click(modifiers=["Shift"])
    assert_selected(page, [0, 1, 2])
    row_cell(page, 7, 2).click(modifiers=["Control"])
    assert_selected(page, [0, 1, 2, 7])
    row_cell(page, 1).click(modifiers=["Control"])
    assert_selected(page, [0, 2, 7])
    row_cell(page, 4).click(modifiers=["Control", "Shift"])
    assert_selected(page, [0, 1, 2, 3, 4, 7])
    assert page.evaluate("String(window.getSelection())") == "", "修饰键点击不应产生浏览器原生文本选区"
    row_cell(page, 5, 2).click()
    assert_selected(page, [5])
    row_cell(page, 5).click(modifiers=["Control"])
    assert_selected(page, [])
    expect(page.locator(".cell-sel")).to_have_count(0)
    expect(page.locator("#sbCell")).to_have_text("")
    page.evaluate("navigator.clipboard.writeText('empty-selection-marker')")
    page.keyboard.press("Control+c")
    assert clipboard(page) == "empty-selection-marker"
    row_cell(page, 8).click(modifiers=["Shift"])
    assert_selected(page, [5, 6, 7, 8])
    field = page.locator('.winput')
    field.evaluate("el => { el.value = 'editable clipboard'; }")
    field.focus()
    field.press("Control+a")
    field.press("Control+c")
    wait_clipboard(page, "editable clipboard")
    row_cell(page, 2).click(modifiers=["Control"])
    assert_selected(page, [2, 5, 6, 7, 8])
    expect(page.locator("table.grid")).to_be_focused()
    print("PASS browser: Shift 正反向连选与缩小、Ctrl 增删、Ctrl+Shift 追加、零选择、输入框复制与焦点", flush=True)


def test_multi_copy(page):
    select_rows(page, MULTI_CLICK_ORDER)
    assert_selected(page, MULTI_ROWS)
    page.evaluate("window.gridFixture.redraw()")
    assert_selected(page, MULTI_ROWS)
    expect(page.locator("table.grid")).to_be_focused()
    expected = page.evaluate("indices => indices.map(index => window.gridFixture.row(index))", MULTI_ROWS)
    records = [dict(zip(item["columns"], item["row"])) for item in expected]
    assert json.loads(copy_rows(page, "JSON")) == records
    for format_name, delimiter in [("CSV", ","), ("TSV", "\t")]:
        parsed = list(csv.reader(io.StringIO(copy_rows(page, format_name), newline=None), delimiter=delimiter))
        assert parsed[0] == expected[0]["columns"]
        assert len(parsed) == len(MULTI_ROWS) + 1
        assert [record[0] for record in parsed[1:]] == [str(index + 1) for index in MULTI_ROWS]
        assert [record[1] for record in parsed[1:]] == [item["row"][1] for item in expected]
        assert [record[7] for record in parsed[1:]] == [item["row"][7] for item in expected]
    sql = copy_rows(page, "INSERT")
    assert sql.count("INSERT INTO ") == len(MULTI_ROWS)
    assert f"INSERT INTO {MYSQL_QUOTE}fixture_db{MYSQL_QUOTE}.{MYSQL_QUOTE}demo_records{MYSQL_QUOTE}" in sql
    page.keyboard.press("Control+c")
    page.wait_for_function("navigator.clipboard.readText().then(text => text.startsWith('2\\t'))")
    copied = list(csv.reader(io.StringIO(clipboard(page), newline=None), delimiter="\t"))
    assert len(copied) == len(MULTI_ROWS), "Ctrl+C 多选复制不应附带表头"
    assert [record[0] for record in copied] == [str(index + 1) for index in MULTI_ROWS]
    row_cell(page, 6).click(modifiers=["Shift"])
    assert_selected(page, [4, 5, 6])
    open_row_menu(page, 0)
    assert_selected(page, [0])
    expect(page.get_by_role("menuitem", name="复制整行为 JSON", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    row_cell(page, 0, 3).click()
    page.keyboard.press("Control+c")
    wait_clipboard(page, "")
    long_value = page.evaluate("window.gridFixture.row(2).row[7]")
    row_cell(page, SELECTED_ROW, 8).click()
    page.keyboard.press("Control+c")
    wait_clipboard(page, long_value)
    page.locator(".gridwrap").evaluate("el => { el.scrollLeft = 0; el.scrollTop = 0; }")
    row_cell(page, SELECTED_ROW).click()
    print("PASS browser: 右键保留多选、JSON/CSV/TSV/INSERT 按行顺序复制、Ctrl+C、单值完整性、右键非选中行", flush=True)


def test_multi_state_isolation(page, output):
    page.evaluate("window.gridFixture.showTable()")
    select_rows(page, MULTI_CLICK_ORDER)
    freeze_rows(page, MULTI_ROWS[1], MULTI_ROWS[1] + 1)
    freeze_columns(page, 1, "name")
    assert_selected(page, MULTI_ROWS)
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    page.screenshot(path=str(output / "grid-multi-light.png"))
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    page.screenshot(path=str(output / "grid-multi-dark.png"))
    page.evaluate("window.gridFixture.showConsole()")
    page.locator('[data-act="res-tab"][data-i="0"]').click()
    select_rows(page, [2, 4, 6])
    open_row_menu(page, 4)
    menu_click(page, "复制所选 3 行为 INSERT")
    dialog = page.get_by_role("dialog", name="复制所选 3 行为 INSERT")
    expect(dialog.get_by_label("模式", exact=True)).to_have_value("public")
    page.evaluate("window.gridFixture.showTable()")
    dialog.get_by_label("目标表").fill("copied_multi_records")
    dialog.get_by_role("button", name="复制 INSERT", exact=True).click()
    expect(dialog).to_have_count(0)
    copied = clipboard(page)
    assert copied.count('INSERT INTO "public"."copied_multi_records"') == 3
    assert 'VALUES (103,' in copied and 'VALUES (107,' in copied, "弹窗复制必须使用原查询结果快照"
    page.evaluate("window.gridFixture.showConsole()")
    assert_selected(page, [2, 4, 6])
    page.locator('[data-act="res-tab"][data-i="1"]').click()
    select_rows(page, [8, 10])
    page.locator('[data-act="res-tab"][data-i="0"]').click()
    assert_selected(page, [2, 4, 6])
    page.locator('[data-act="con-page"][data-page="1"]').first.click()
    assert_selected(page, [])
    row_cell(page, 3).click(modifiers=["Shift"])
    assert_selected(page, [3])
    page.locator('[data-act="res-tab"][data-i="1"]').click()
    assert_selected(page, [8, 10])
    page.evaluate("window.gridFixture.showTable()")
    assert_selected(page, MULTI_ROWS)
    expect(page.locator("table.grid")).to_have_attribute("data-frozen-rows", str(MULTI_ROWS[1] + 1))
    page.evaluate("window.gridFixture.refreshTable()")
    assert_selected(page, [])
    row_cell(page, 3).click(modifiers=["Shift"])
    assert_selected(page, [3])
    print("PASS browser: 多选与冻结共存、明暗主题、表/结果状态隔离、分页/刷新重置起点、跨标签 INSERT 快照", flush=True)


def test_selection_and_copy(page):
    selected = page.locator("table.grid tbody tr").nth(SELECTED_ROW)
    row_cell(page, SELECTED_ROW, 2).click()
    expect(selected).to_have_attribute("aria-selected", "true")
    color = row_cell(page, SELECTED_ROW, 2).evaluate("el => getComputedStyle(el).backgroundColor")
    page.locator("#fixtureToolbar").hover()
    assert row_cell(page, SELECTED_ROW, 2).evaluate("el => getComputedStyle(el).backgroundColor") == color
    expect(selected).to_have_class("row-selected")
    expected = page.evaluate("index => window.gridFixture.row(index)", SELECTED_ROW)
    record = dict(zip(expected["columns"], expected["row"]))
    assert json.loads(copy_row(page, SELECTED_ROW, "JSON")) == record
    assert record["nullable"] is None and isinstance(record["id"], int)
    for format_name, delimiter in [("CSV", ","), ("TSV", "\t")]:
        # Windows 文本剪贴板统一使用 CRLF，按通用换行读取后比较字段内容。
        stream = io.StringIO(copy_row(page, SELECTED_ROW, format_name), newline=None)
        copied = list(csv.reader(stream, delimiter=delimiter))
        assert copied[0] == expected["columns"]
        assert copied[1][0] == str(record["id"])
        assert copied[1][1] == record["name"], (format_name, repr(copied[1][1]), repr(record["name"]))
        assert copied[1][2] == ""
        assert copied[1][7] == record["long_text"]
    insert = copy_row(page, SELECTED_ROW, "INSERT")
    assert insert.startswith(f"INSERT INTO {MYSQL_QUOTE}fixture_db{MYSQL_QUOTE}.{MYSQL_QUOTE}demo_records{MYSQL_QUOTE} (")
    assert "O''Reilly" in insert and "NULL" in insert and "CONVERT(X'" in insert
    page.evaluate("window.gridFixture.redraw()")
    expect(page.locator("table.grid tbody tr").nth(SELECTED_ROW)).to_have_attribute("aria-selected", "true")
    print("PASS browser: 持续行选中、原始整行 JSON/CSV/TSV/MySQL INSERT、重绘恢复", flush=True)


def freeze_rows(page, row_index, display_number):
    open_row_menu(page, row_index)
    menu_click(page, "冻结到第 " + str(display_number) + " 行")


def freeze_columns(page, column_index, name):
    page.locator("table.grid thead th").nth(column_index + 1).click(button="right")
    menu_click(page, "冻结到第 " + str(column_index + 1) + " 列（" + name + "）")


def test_freeze_and_resize(page, output):
    freeze_rows(page, SELECTED_ROW, FROZEN_ROWS)
    freeze_columns(page, FROZEN_COLUMNS - 1, "name")
    grid = page.locator("table.grid")
    expect(grid).to_have_attribute("data-frozen-rows", str(FROZEN_ROWS))
    expect(grid).to_have_attribute("data-frozen-columns", str(FROZEN_COLUMNS))
    fixed = row_cell(page, SELECTED_ROW, FROZEN_COLUMNS)
    before = fixed.bounding_box()
    scrolling = row_cell(page, FROZEN_ROWS + 1, FROZEN_COLUMNS + 1)
    scrolling_before = scrolling.bounding_box()
    page.locator(".gridwrap").evaluate("(el, offset) => { el.scrollLeft = offset.x; el.scrollTop = offset.y; }",
                                      {"x": SCROLL_X, "y": SCROLL_Y})
    page.wait_for_function("(y) => document.querySelector('.gridwrap').scrollTop === y", arg=SCROLL_Y)
    after = fixed.bounding_box()
    assert_position(after["x"], before["x"])
    assert_position(after["y"], before["y"])
    assert_position(scrolling.bounding_box()["x"], scrolling_before["x"] - SCROLL_X)
    assert_position(scrolling.bounding_box()["y"], scrolling_before["y"] - SCROLL_Y)
    assert fixed.evaluate("""el => {
      const box = el.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('td') === el;
    }"""), "冻结行列交叉区域被其他数据覆盖"
    resizer = page.locator('.th-rs[data-ci="0"]')
    handle = resizer.bounding_box()
    point_x, point_y = handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2
    page.mouse.move(point_x, point_y)
    page.mouse.down()
    page.mouse.move(point_x + RESIZE_DELTA, point_y)
    page.mouse.up()
    page.wait_for_function("""expected => {
      const cell = document.querySelector('tbody tr[data-ri="2"] td[data-ci="1"]');
      return Math.abs(cell.getBoundingClientRect().x - expected) < 1.5;
    }""", arg=before["x"] + RESIZE_DELTA)
    assert_position(fixed.bounding_box()["x"], before["x"] + RESIZE_DELTA)
    page.screenshot(path=str(output / "grid-light.png"))
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    page.screenshot(path=str(output / "grid-dark.png"))
    print("PASS browser: 行列同时冻结、横纵滚动、交叉区域层级、拖动列宽、双主题", flush=True)


def test_console(page):
    page.evaluate("window.gridFixture.showConsole()")
    grid = page.locator("table.grid")
    expect(grid).to_have_attribute("data-frozen-rows", "0")
    expect(grid).to_have_attribute("data-frozen-columns", "0")
    expect(page.locator(".row-selected")).to_have_count(0)
    freeze_rows(page, 1, 2)
    freeze_columns(page, 2, "nullable")
    page.locator('[data-act="res-tab"][data-i="1"]').click()
    expect(grid).to_have_attribute("data-frozen-rows", "0")
    row_cell(page, 0).click()
    page.locator('[data-act="res-tab"][data-i="0"]').click()
    expect(grid).to_have_attribute("data-frozen-rows", "2")
    expect(grid).to_have_attribute("data-frozen-columns", "3")
    expect(page.locator('tbody tr[data-ri="1"]')).to_have_attribute("aria-selected", "true")
    page.locator('[data-act="con-page"][data-page="2"]').first.click()
    expect(grid).to_have_attribute("data-frozen-rows", "2")
    expect(grid).to_have_attribute("data-frozen-columns", "3")
    expect(page.locator(".row-selected")).to_have_count(0)
    copied = json.loads(copy_row(page, 0, "JSON"))
    assert copied["id"] == PAGE_ROWS + 1
    open_row_menu(page, 0)
    menu_click(page, "复制整行为 INSERT")
    dialog = page.get_by_role("dialog", name="复制整行为 INSERT")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_label("模式", exact=True)).to_have_value("public")
    dialog.get_by_label("目标表").fill("copied_records")
    dialog.get_by_role("button", name="复制 INSERT", exact=True).click()
    expect(dialog).to_have_count(0)
    assert clipboard(page).startswith('INSERT INTO "public"."copied_records" ("id", "name",')
    assert "E'O''Reilly" in clipboard(page)
    print("PASS browser: 控制台结果隔离、换页保持冻结并清除选择、PostgreSQL 执行上下文", flush=True)


def test_unfreeze_and_empty(page):
    page.evaluate("window.gridFixture.showTable()")
    grid = page.locator("table.grid")
    expect(grid).to_have_attribute("data-frozen-rows", str(FROZEN_ROWS))
    expect(grid).to_have_attribute("data-frozen-columns", str(FROZEN_COLUMNS))
    expect(page.locator('tbody tr[data-ri="2"]')).to_have_attribute("aria-selected", "true")
    open_row_menu(page, SELECTED_ROW)
    menu_click(page, "取消冻结行")
    expect(grid).to_have_attribute("data-frozen-rows", "0")
    expect(grid).to_have_attribute("data-frozen-columns", str(FROZEN_COLUMNS))
    freeze_rows(page, SELECTED_ROW, FROZEN_ROWS)
    open_row_menu(page, SELECTED_ROW)
    menu_click(page, "取消全部冻结")
    expect(grid).to_have_attribute("data-frozen-rows", "0")
    expect(grid).to_have_attribute("data-frozen-columns", "0")
    expect(page.locator('tbody tr[data-ri="2"]')).to_have_attribute("aria-selected", "true")
    page.evaluate("window.gridFixture.showEmpty()")
    expect(page.locator("table.grid tbody tr")).to_have_count(0)
    expect(page.get_by_text("查询结果为空", exact=True)).to_be_visible()
    freeze_columns(page, 1, "name")
    expect(grid).to_have_attribute("data-frozen-columns", "2")
    print("PASS browser: 切换表恢复状态、分轴与全部取消冻结、空结果列冻结", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:18765")
    parser.add_argument("--browser", help="Chromium 可执行文件路径")
    parser.add_argument("--output", type=Path, required=True, help="截图输出目录")
    parser.add_argument("--inspect", action="store_true", help="仅检查初始 DOM 并截图")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.browser)
        context = browser.new_context(viewport=VIEWPORT, permissions=["clipboard-read", "clipboard-write"])
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(args.url + "/test/grid-fixture.html")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("Boolean(window.gridFixture)")
            expect(page.locator("table.grid tbody tr")).to_have_count(PAGE_ROWS)
            if args.inspect:
                page.screenshot(path=str(args.output / "grid-initial.png"))
                print(page.locator("table.grid thead").inner_text(), flush=True)
                print("rows=" + str(page.locator("table.grid tbody tr").count()), flush=True)
                return
            test_selection_and_copy(page)
            test_modifier_selection(page)
            test_multi_copy(page)
            test_freeze_and_resize(page, args.output)
            test_console(page)
            test_unfreeze_and_empty(page)
            test_multi_state_isolation(page, args.output)
            assert not errors, errors
            print("PASS browser: 无 JavaScript 运行时异常", flush=True)
        except Exception:
            page.screenshot(path=str(args.output / "grid-failure.png"))
            print("page errors: " + json.dumps(errors, ensure_ascii=False), flush=True)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
