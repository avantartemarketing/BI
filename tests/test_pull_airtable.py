"""The Airtable pull's rules for the two colleagues it names
(etl/pull_airtable.py): a project manager's or marketing lead's display name
from a collaborator field, never the email beside it; the project manager's
Slack member ID kept only in that shape; and check_schema letting those
fields through while refusing an email-typed or collaborator-typed one in
their place.  .venv/bin/python3 tests/test_pull_airtable.py"""
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pull_airtable", ROOT / "etl" / "pull_airtable.py")
pa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pa)


def test_cells() -> None:
    hits = [0]
    collab = {"id": "usr1", "email": "claud@example.com", "name": "Claud Example"}
    assert pa.flatten(collab, "project_manager", hits) == "Claud Example"
    assert pa.flatten(collab, "marketing_lead", hits) == "Claud Example"
    assert pa.flatten(collab, "title", hits) == "", "a collaborator anywhere else is dropped"
    assert pa.flatten("U05LE1G3AJC", "pm_slack_id", hits) == "U05LE1G3AJC"
    assert pa.flatten("W012ABCDEFG", "pm_slack_id", hits) == "W012ABCDEFG"
    assert pa.flatten("Claud", "pm_slack_id", hits) == "", "a name where the ID should be does not travel"
    assert pa.flatten("#ERROR!", "pm_slack_id", hits) == "", "an empty collaborator's formula error does not either"
    assert pa.flatten("", "pm_slack_id", hits) == "" and pa.flatten(None, "pm_slack_id", hits) == ""
    assert pa.flatten("claud@example.com", "pm_slack_id", hits) == ""
    assert hits[0] == 0, "the ID rule drops it before the address scan counts it"
    assert pa.flatten("call 0044 7700 900123", "medium", hits) == "" and hits[0] == 1, "the address scan still runs elsewhere"
    # a work's page on the shop travels as its path there and nothing else
    assert pa.flatten("https://avantarte.com/products/marina-abramovic-energy-hat-eyes-open-red", "product_page_url", hits) == "/products/marina-abramovic-energy-hat-eyes-open-red"
    assert pa.flatten("https://avantarte.com/products/A-Work/?utm_source=x", "product_page_url", hits) == "/products/a-work"
    assert pa.flatten("/products/a-work", "product_page_url", hits) == "/products/a-work"
    assert pa.flatten("https://admin.shopify.com/store/shop/products/123", "product_page_url", hits) == "", "a link that is not a product page's does not travel"
    assert pa.flatten("ask claud@example.com", "product_page_url", hits) == "" and pa.flatten("-6%", "product_page_url", hits) == ""
    assert pa.flatten("https://example.com/a", "medium", hits) == "", "links are still dropped everywhere else"
    print("cells: ok")


def fields(**over) -> dict:
    f = {name: {"name": name, "type": "singleLineText"} for name, _ in pa.FIELDS}
    f[pa.PRICE_FIELD] = {"name": pa.PRICE_FIELD, "type": "currency", "options": {"symbol": "€"}}
    f["Marketing lead"] = {"name": "Marketing lead", "type": "multipleCollaborators"}
    f["Project Manager"] = {"name": "Project Manager", "type": "singleCollaborator"}
    f["PM Slack ID"] = {"name": "PM Slack ID", "type": "formula", "options": {"result": {"type": "singleLineText"}}}
    f.update(over)
    return f


def test_schema() -> None:
    names, currency, found, absent = pa.check_schema(fields())
    assert currency == "EUR"
    assert found["Project Manager"] == "project_manager" and found["PM Slack ID"] == "pm_slack_id" and found["Marketing lead"] == "marketing_lead"
    assert "Project Manager" in names and "PM Slack ID" in names and "Target sell-through %" in absent, (names, absent)
    for bad in ({"Project Manager": {"name": "Project Manager", "type": "email"}},
                {"PM Slack ID": {"name": "PM Slack ID", "type": "singleCollaborator"}},
                {"PM Slack ID": {"name": "PM Slack ID", "type": "formula", "options": {"result": {"type": "email"}}}},
                {"Title": {"name": "Title", "type": "singleCollaborator"}}):
        try:
            pa.check_schema(fields(**bad))
        except SystemExit as e:
            assert "refusing to pull fields that hold a person" in str(e), str(e)
        else:
            raise AssertionError(f"accepted {bad}")
    print("schema: ok")


if __name__ == "__main__":
    test_cells()
    test_schema()
