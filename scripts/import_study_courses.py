"""Imports the "Study Master Games" Lichess studies into the courses table as
hidden STUDY courses, one course per cohort.

Each "Study Master Games" requirement links its cohort's Lichess study in its
description. This script fetches every study's PGN, splits it into games the
same way the backend's Lichess import does, and writes one course per cohort
with one chapter per game. Courses are create-only. An id that already exists
is skipped, so a re-run never overwrites a course an admin has edited.

Usage:
    python3 import_study_courses.py                # dry run, prints the plan
    python3 import_study_courses.py --apply        # writes the courses
    python3 import_study_courses.py --cohort 1500-1600
"""

import argparse
import re
import sys
import time
import urllib.request
import uuid

import boto3

REQUIREMENT_NAME = 'Study Master Games'
REQUIREMENT_STATUS = 'ACTIVE'
STUDY_LINK = re.compile(r'https://lichess\.org/study/([A-Za-z0-9]+)')
STUDY_EXPORT_URL = 'https://lichess.org/study/{}.pgn?source=true'

# The split the backend applies to a Lichess study export, from splitPgns in
# common/src/pgn/pgn.ts. A game ends at a result token followed by newlines
# and the next header section.
PGN_SEPARATOR = re.compile(r'(1-0|0-1|1/2-1/2|\*)(\r?\n)+\[')
RESULTS = ('1-0', '0-1', '1/2-1/2', '*')
HEADER = re.compile(r'^\[(\w+) "(.*)"\]\s*$')

# Headers that describe the Lichess study rather than the game.
DROPPED_HEADERS = ('Annotator', 'StudyName', 'ChapterName', 'ChapterURL')

# The DynamoDB item size limit. The largest study is 51 KB of PGN.
MAX_ITEM_BYTES = 400 * 1024

parser = argparse.ArgumentParser(
    description='Import the Study Master Games Lichess studies as STUDY courses'
)
parser.add_argument('--apply', action='store_true', help='Write the courses. Without it, only print the plan')
parser.add_argument('--cohort', type=str, help='Import only this cohort (Ex: 1500-1600)')
parser.add_argument('--owner', type=str, default='google_112538452360881134254', help='The username set as the course owner')
parser.add_argument('--owner-display-name', type=str, default='ChessDojo', help='The display name set as the course owner')
parser.add_argument('--requirements-table', type=str, default='dev-requirements')
parser.add_argument('--courses-table', type=str, default='dev-courses')


def split_pgns(text: str) -> list:
    """Splits a multi-game PGN into single games, matching splitPgns in common."""
    games = []
    for split in PGN_SEPARATOR.split(text):
        if split is None:
            continue
        if split in RESULTS and games:
            games[-1] += split
        elif split.startswith('[') or re.match(r'^\d+', split.strip()):
            games.append(split)
        elif split.strip():
            games.append('[' + split)
    return [g.strip() for g in games if g.strip()]


def parse_headers(pgn: str) -> dict:
    headers = {}
    for line in pgn.splitlines():
        match = HEADER.match(line)
        if not match:
            if line.strip() == '':
                break
            continue
        headers[match.group(1)] = match.group(2)
    return headers


def strip_headers(pgn: str, names=DROPPED_HEADERS) -> str:
    """Removes the given headers from the PGN and leaves the rest untouched."""
    kept = []
    in_headers = True
    for line in pgn.splitlines():
        if in_headers:
            match = HEADER.match(line)
            if match and match.group(1) in names:
                continue
            if not match and line.strip() == '':
                in_headers = False
        kept.append(line)
    return '\n'.join(kept).strip()


def has_moves(pgn: str) -> bool:
    body = pgn.split('\n\n', 1)[1] if '\n\n' in pgn else ''
    body = re.sub(r'\{[^}]*\}', '', body)
    return re.search(r'\d+\.', body) is not None


def course_id(cohort: str) -> str:
    return 'study-master-games-' + cohort.replace('+', 'plus')


def study_id(requirement: dict) -> str:
    match = STUDY_LINK.search(requirement.get('description', ''))
    if not match:
        raise Exception(f'Requirement {requirement["id"]} has no Lichess study link in its description')
    return match.group(1)


def requirement_cohort(requirement: dict) -> str:
    cohorts = list(requirement.get('counts', {}).keys())
    if len(cohorts) != 1:
        raise Exception(f'Requirement {requirement["id"]} has {len(cohorts)} cohorts, expected 1')
    return cohorts[0]


def build_chapter(pgn: str) -> dict:
    """Turns one study chapter into a course chapter with one PGN viewer module."""
    headers = parse_headers(pgn)
    name = headers.get('ChapterName') or f'{headers.get("White", "?")} vs {headers.get("Black", "?")}'
    return {
        'name': name,
        'modules': [
            {
                'id': str(uuid.uuid4()),
                'name': name,
                'type': 'PGN_VIEWER',
                'description': '',
                'postscript': '',
                'videoUrls': [],
                'pgns': [strip_headers(pgn)],
                'positions': [],
                'boardOrientation': 'white',
            }
        ],
    }


def build_course(requirement: dict, cohort: str, pgns: list, owner: str, owner_display_name: str) -> dict:
    return {
        'type': 'STUDY',
        'id': course_id(cohort),
        'owner': owner,
        'ownerDisplayName': owner_display_name,
        'stripeId': '',
        'name': f'Master Games {cohort}',
        'description': requirement['description'],
        'whatsIncluded': [],
        'color': 'None',
        'cohorts': [cohort],
        'cohortRange': cohort,
        'includedWithSubscription': True,
        'availableForFreeUsers': False,
        'allowExport': False,
        'purchaseOptions': [],
        'chapters': [build_chapter(pgn) for pgn in pgns],
        'status': 'PUBLISHED',
    }


def fetch_study(study: str) -> str:
    request = urllib.request.Request(STUDY_EXPORT_URL.format(study), headers={'User-Agent': 'chess-dojo import_study_courses'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode('utf-8')


def list_requirements(table) -> list:
    """Returns the active requirements with the given name, in table order."""
    items = []
    kwargs = {
        'KeyConditionExpression': '#status = :status',
        'FilterExpression': '#name = :name',
        'ExpressionAttributeNames': {'#status': 'status', '#name': 'name'},
        'ExpressionAttributeValues': {':status': REQUIREMENT_STATUS, ':name': REQUIREMENT_NAME},
    }
    while True:
        res = table.query(**kwargs)
        items.extend(res.get('Items', []))
        last_key = res.get('LastEvaluatedKey')
        if not last_key:
            return items
        kwargs['ExclusiveStartKey'] = last_key


def course_exists(table, course: dict) -> bool:
    res = table.get_item(
        Key={'type': course['type'], 'id': course['id']},
        ProjectionExpression='#id',
        ExpressionAttributeNames={'#id': 'id'},
    )
    return 'Item' in res


def pgn_bytes(course: dict) -> int:
    return sum(len(pgn.encode('utf-8')) for chapter in course['chapters'] for pgn in chapter['modules'][0]['pgns'])


def describe(course: dict, expected_count: int, exists: bool):
    chapters = course['chapters']
    size = pgn_bytes(course)
    print(f'{course["cohortRange"]:10} {course["id"]:32} {len(chapters):3} chapters  {size:7} PGN bytes  {"exists, skip" if exists else "create"}')
    print(f'{"":10}   first: {chapters[0]["name"]}')
    print(f'{"":10}   last:  {chapters[-1]["name"]}')
    if len(chapters) != expected_count:
        print(f'{"":10}   note: the requirement count is {expected_count}')
    for i, chapter in enumerate(chapters):
        if not has_moves(chapter['modules'][0]['pgns'][0]):
            print(f'{"":10}   note: chapter {i + 1} "{chapter["name"]}" has no moves')
    if size > MAX_ITEM_BYTES:
        print(f'{"":10}   error: over the {MAX_ITEM_BYTES} byte item limit')


def main():
    args = parser.parse_args()
    db = boto3.resource('dynamodb')
    requirements = db.Table(args.requirements_table)
    courses = db.Table(args.courses_table)

    rows = list_requirements(requirements)
    if args.cohort:
        rows = [row for row in rows if requirement_cohort(row) == args.cohort]
        if not rows:
            sys.exit(f'No {REQUIREMENT_NAME} requirement for cohort {args.cohort}')
    rows.sort(key=lambda row: int(re.match(r'\d+', requirement_cohort(row)).group(0)))
    print(f'Got {len(rows)} {REQUIREMENT_NAME} requirements')

    plan = []
    for row in rows:
        cohort = requirement_cohort(row)
        expected = int(row['counts'][cohort])
        text = fetch_study(study_id(row))
        time.sleep(1)
        course = build_course(row, cohort, split_pgns(text), args.owner, args.owner_display_name)
        if not course['chapters']:
            raise Exception(f'Study for {cohort} has no games')
        exists = course_exists(courses, course)
        describe(course, expected, exists)
        if pgn_bytes(course) > MAX_ITEM_BYTES:
            sys.exit(1)
        plan.append((course, exists))

    if not args.apply:
        print(f'Dry run: {sum(1 for _, exists in plan if not exists)} to create, {sum(1 for _, exists in plan if exists)} to skip. Pass --apply to write.')
        return

    created = 0
    skipped = 0
    for course, _ in plan:
        try:
            courses.put_item(
                Item=course,
                ConditionExpression='attribute_not_exists(id)',
            )
            created += 1
        except courses.meta.client.exceptions.ConditionalCheckFailedException:
            skipped += 1
    print(f'Created: {created}, skipped: {skipped}')


if __name__ == '__main__':
    main()
