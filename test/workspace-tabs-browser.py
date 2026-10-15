"""用生产标签组件和事件委托验证多标签导航；固定数据不连接数据库。"""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

VIEWPORT = {"width": 1320, "height": 780}
NARROW_VIEWPORT = {"width": 880, "height": 620}
SHORT_WINDOW_HEIGHT = 380
OPEN_TAB_COUNT = 30
LAST_TAB_ID = 30
WHEEL_DISTANCE = 460
POSITION_TOLERANCE = 1.5
SCROLLER = ".tabs-scroll"
TRIGGER = '[data-tab-action="toggle-list"]'
SEARCH = "#tabListSearch"
OPTIONS = "#tabListResults [role=option]"


def active_tab(page):
    return page.locator("#tabbar .tab.active")


def assert_active_visible(page):
    assert active_tab(page).evaluate("""(element, tolerance) => {
      const item = element.getBoundingClientRect();
      const viewport = element.parentElement.getBoundingClientRect();
      return item.left >= viewport.left - tolerance && item.right <= viewport.right + tolerance;
    }""", POSITION_TOLERANCE), "当前标签被滚动区域裁切"


def open_list(page):
    page.locator(TRIGGER).click()
    expect(page.get_by_role("dialog", name="已打开的标签")).to_be_visible()
    expect(page.locator(SEARCH)).to_be_focused()
    expect(page.locator(TRIGGER)).to_have_attribute("aria-expanded", "true")


def test_overflow_and_redraw(page):
    expect(page.locator("#tabbar .tab")).to_have_count(OPEN_TAB_COUNT)
    expect(page.locator(".tab-scroll-controls")).to_be_visible()
    assert page.locator(SCROLLER).evaluate("el => el.clientHeight >= el.scrollHeight"), "标签被滚动条挤压"
    widths = page.locator("#tabbar .tab").evaluate_all("tabs => tabs.map(tab => tab.getBoundingClientRect().width)")
    assert max(widths) - min(widths) <= POSITION_TOLERANCE, widths
    assert page.locator("#tabbar .tab").evaluate_all("""tabs => tabs.every(tab => {
      const label = tab.querySelector('.tab-label').getBoundingClientRect();
      const close = tab.querySelector('.x').getBoundingClientRect();
      return label.right < close.left;
    })"""), "名称覆盖关闭按钮"
    page.evaluate("id => window.tabsFixture.activate(id)", LAST_TAB_ID)
    assert_active_visible(page)
    previous = page.locator(SCROLLER).evaluate("el => el.scrollLeft")
    page.locator(SCROLLER).hover()
    page.mouse.wheel(0, -WHEEL_DISTANCE)
    page.wait_for_function("previous => document.querySelector('.tabs-scroll').scrollLeft < previous", arg=previous)
    scrolled = page.locator(SCROLLER).evaluate("el => el.scrollLeft")
    page.evaluate("window.tabsFixture.redraw()")
    actual = page.locator(SCROLLER).evaluate("el => el.scrollLeft")
    assert abs(actual - scrolled) <= POSITION_TOLERANCE, (actual, scrolled)
    page.evaluate("id => window.tabsFixture.activate(id)", LAST_TAB_ID)
    assert_active_visible(page)
    page.locator(SCROLLER).evaluate("el => { el.scrollLeft = 0; }")
    expect(page.get_by_role("button", name="向左浏览标签")).to_be_disabled()
    page.get_by_role("button", name="向右浏览标签").click()
    page.wait_for_function("document.querySelector('.tabs-scroll').scrollLeft > 0")
    expect(page.get_by_role("button", name="向左浏览标签")).to_be_enabled()
    page.get_by_role("button", name="向左浏览标签").click()
    expect(page.get_by_role("button", name="向左浏览标签")).to_be_disabled()
    print("PASS browser: 30 个标签、名称截断、滚轮/箭头浏览、重绘保留位置、当前标签重新定位", flush=True)


def test_search_and_focus(page):
    open_list(page)
    expect(page.locator(OPTIONS)).to_have_count(OPEN_TAB_COUNT)
    page.locator(SEARCH).fill("PROVIDER audit")
    expect(page.locator(OPTIONS)).to_have_count(1)
    expect(page.locator(OPTIONS)).to_contain_text("workspace_demo.audit")
    page.locator(SEARCH).press("Enter")
    expect(page.locator("#tabListMenu")).to_be_hidden()
    expect(active_tab(page)).to_have_attribute("data-id", "28")
    expect(active_tab(page)).to_be_focused()
    assert_active_visible(page)
    open_list(page)
    page.locator(SEARCH).fill("workflow")
    expect(page.locator(OPTIONS)).to_have_count(3)
    expect(page.locator(".tab-list-count")).to_have_text("3 / 30")
    page.locator(SEARCH).press("ArrowDown")
    expect(page.locator(SEARCH)).to_have_attribute("aria-activedescendant", "tab-option-26")
    page.locator(SEARCH).press("Enter")
    expect(active_tab(page)).to_have_attribute("data-id", "26")
    assert_active_visible(page)
    open_list(page)
    page.locator(SEARCH).fill("没有这个表")
    expect(page.locator(OPTIONS)).to_have_count(0)
    expect(page.locator(".tab-list-empty")).to_be_visible()
    page.locator(SEARCH).press("Enter")
    expect(page.locator("#tabListMenu")).to_be_visible()
    page.locator(SEARCH).press("Escape")
    expect(page.locator("#tabListMenu")).to_be_hidden()
    expect(page.locator(TRIGGER)).to_be_focused()
    expect(page.locator(TRIGGER)).to_have_attribute("aria-expanded", "false")
    open_list(page)
    page.locator(SEARCH).evaluate("el => el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', isComposing:true, bubbles:true}))")
    expect(page.locator("#tabListMenu")).to_be_visible()
    page.locator("#sbStatus").click()
    expect(page.locator("#tabListMenu")).to_be_hidden()
    expect(page.locator(TRIGGER)).to_have_attribute("aria-expanded", "false")
    print("PASS browser: 全量搜索、同名表 schema 区分、上下键选择、Enter/Escape、空结果、中文输入与焦点恢复", flush=True)


def test_keyboard_and_close(page):
    active_tab(page).focus()
    active_tab(page).press("Home")
    expect(active_tab(page)).to_have_attribute("data-id", "1")
    active_tab(page).press("End")
    expect(active_tab(page)).to_have_attribute("data-id", str(LAST_TAB_ID))
    active_tab(page).press("ArrowRight")
    expect(active_tab(page)).to_have_attribute("data-id", "1")
    active_tab(page).press("ArrowLeft")
    expect(active_tab(page)).to_have_attribute("data-id", str(LAST_TAB_ID))
    active_tab(page).press("Delete")
    expect(page.locator("#tabbar .tab")).to_have_count(OPEN_TAB_COUNT - 1)
    assert page.evaluate("id => window.tabsFixture.getState().tabs.find(tab => tab.id === id).open", LAST_TAB_ID) is False
    assert_active_visible(page)
    page.evaluate("window.tabsFixture.reset()")
    active_tab(page).click(button="right")
    expect(page.locator("#tabContextMenu")).to_be_visible()
    page.locator('#tabContextMenu [data-mode="others"]').click()
    expect(page.locator("#tabbar .tab")).to_have_count(1)
    expect(page.locator(".tab-count")).to_have_text("1")
    expect(page.locator(".tab-scroll-controls")).to_be_hidden()
    active_tab(page).locator('[data-act="close-tab"]').click()
    expect(page.locator("#tabbar .tab")).to_have_count(0)
    expect(page.locator(TRIGGER)).to_be_disabled()
    expect(page.locator(".tabs-empty")).to_be_visible()
    page.locator('[data-act="toggle-console-menu"]').click()
    page.locator('[data-act="open-default-console"]').click()
    expect(page.locator("#tabbar .tab")).to_have_count(1)
    expect(active_tab(page)).to_contain_text("会务查询")
    page.locator('[data-act="toggle-console-menu"]').click()
    page.locator('[data-act="new-console"]').click()
    expect(page.locator("#tabbar .tab")).to_have_count(2)
    expect(active_tab(page)).to_contain_text("临时查询")
    print("PASS browser: 标签键盘导航、关闭控制台保留草稿、批量关闭、空状态、重开与新建控制台", flush=True)


def test_resize_and_screenshots(page, output):
    page.evaluate("window.tabsFixture.reset()")
    page.evaluate("window.tabsFixture.activate(23)")
    assert_active_visible(page)
    page.locator("#tabbar").screenshot(path=str(output / "tabs-strip.png"))
    page.screenshot(path=str(output / "tabs-light.png"))
    open_list(page)
    page.locator(SEARCH).fill("provider")
    page.screenshot(path=str(output / "tabs-search-light.png"))
    page.locator(SEARCH).press("Escape")
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    open_list(page)
    page.locator(SEARCH).fill("provider")
    page.screenshot(path=str(output / "tabs-search-dark.png"))
    page.locator(SEARCH).press("Escape")
    page.set_viewport_size(NARROW_VIEWPORT)
    page.wait_for_function("document.querySelector('#tabbar').clientWidth < 600")
    assert_active_visible(page)
    open_list(page)
    popup = page.locator("#tabListMenu").bounding_box()
    assert popup["x"] >= 0 and popup["x"] + popup["width"] <= NARROW_VIEWPORT["width"]
    assert popup["y"] + popup["height"] <= NARROW_VIEWPORT["height"]
    page.screenshot(path=str(output / "tabs-narrow.png"))
    page.set_viewport_size({**NARROW_VIEWPORT, "height": SHORT_WINDOW_HEIGHT})
    page.wait_for_function("height => document.querySelector('#tabListMenu').getBoundingClientRect().bottom <= height", arg=SHORT_WINDOW_HEIGHT)
    expect(page.locator(SEARCH)).to_be_visible()
    page.locator(SEARCH).press("Escape")
    page.evaluate("window.tabsFixture.reset(3)")
    page.set_viewport_size({"width": 950, "height": 620})
    expect(page.locator(".tab-scroll-controls")).to_be_hidden()
    page.set_viewport_size({"width": 850, "height": 620})
    expect(page.locator(".tab-scroll-controls")).to_be_visible()
    page.set_viewport_size({"width": 950, "height": 620})
    expect(page.locator(".tab-scroll-controls")).to_be_hidden()
    print("PASS browser: 明暗主题、窄窗口、菜单边界、当前项随窗口定位、溢出临界宽度稳定", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:18766")
    parser.add_argument("--browser", help="Chromium 可执行文件路径")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--inspect", action="store_true", help="仅检查初始 DOM 并截图")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.browser)
        page = browser.new_page(viewport=VIEWPORT, reduced_motion="reduce")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(args.url + "/test/workspace-tabs-fixture.html")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("Boolean(window.tabsFixture)")
            if args.inspect:
                page.screenshot(path=str(args.output / "tabs-initial.png"))
                print(page.locator("#tabbar").inner_text(), flush=True)
                assert not errors, errors
                return
            test_overflow_and_redraw(page)
            test_search_and_focus(page)
            test_keyboard_and_close(page)
            test_resize_and_screenshots(page, args.output)
            assert not errors, errors
            print("PASS browser: 无 JavaScript 运行时异常", flush=True)
        except Exception:
            page.screenshot(path=str(args.output / "tabs-failure.png"))
            print("page errors: " + json.dumps(errors, ensure_ascii=False), flush=True)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
