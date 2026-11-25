import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from target_guard import require_test_target

def expect_exit(fn):
    try:
        fn()
    except SystemExit:
        return
    raise AssertionError('guard did not refuse')

PROD = "https://utgqjzxfxhtrartcskbf.supabase.co"
TEST = "https://abcdefghijklmnopqrst.supabase.co"

def test_refuses_production_url_and_pooler_user():
    expect_exit(lambda: require_test_target(PROD, allowed_ref="abcdefghijklmnopqrst"))
    expect_exit(lambda: require_test_target("postgres.utgqjzxfxhtrartcskbf", allowed_ref="abcdefghijklmnopqrst"))
    expect_exit(lambda: require_test_target(TEST, PROD, allowed_ref="abcdefghijklmnopqrst"))

def test_requires_explicit_matching_test_ref():
    expect_exit(lambda: require_test_target(TEST, allowed_ref=None))
    expect_exit(lambda: require_test_target(TEST, allowed_ref="zzzzzzzzzzzzzzzzzzzz"))
    expect_exit(lambda: require_test_target("no ref here", allowed_ref="abcdefghijklmnopqrst"))
    assert require_test_target(TEST, "postgres.abcdefghijklmnopqrst", allowed_ref="abcdefghijklmnopqrst") == "abcdefghijklmnopqrst"


if __name__ == '__main__':
    test_refuses_production_url_and_pooler_user(); test_requires_explicit_matching_test_ref(); print('target guard: 2 tests passed')
