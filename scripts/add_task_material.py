"""Points each "Study Master Games" requirement at its cohort's STUDY course.

After --apply, every active "Study Master Games" row in the requirements table has
    material: [{kind: COURSE, courseType: STUDY, courseId: study-master-games-<cohort>}]
and nothing else changed. Rows whose material already matches are skipped, so
a re-run changes nothing. The course must already exist in the courses table,
created by import_study_courses.py. A missing course stops the run.

Usage:
    python3 add_task_material.py            # dry run, prints the planned rows
    python3 add_task_material.py --apply    # writes the material attribute
    python3 add_task_material.py --diff     # compares the rows between dev and prod

The --diff mode prints, per row, the attributes that differ between the dev
and prod requirements tables. After a dev --apply, material and updatedAt
differ on every row. Anything else is real drift. Whoever promotes the rows
with copy_requirements.py runs it, since it needs read access to prod. A row
is looked up in prod under the same status it has in dev.
"""

import argparse
import datetime
import re
import sys

import boto3

REQUIREMENT_NAME = 'Study Master Games'
REQUIREMENT_STATUS = 'ACTIVE'

parser = argparse.ArgumentParser(
    description='Set the material of the Study Master Games requirements to their STUDY courses'
)
parser.add_argument('--apply', action='store_true', help='Write the material. Without it, only print the plan')
parser.add_argument('--diff', action='store_true', help='Print the attributes that differ between the dev and prod rows')
parser.add_argument('--requirements-table', type=str, default='dev-requirements')
parser.add_argument('--courses-table', type=str, default='dev-courses')
parser.add_argument('--prod-requirements-table', type=str, default='prod-requirements')


def course_id(cohort: str) -> str:
    return 'study-master-games-' + cohort.replace('+', 'plus')


def requirement_cohort(requirement: dict) -> str:
    cohorts = list(requirement.get('counts', {}).keys())
    if len(cohorts) != 1:
        raise Exception(f'Requirement {requirement["id"]} has {len(cohorts)} cohorts, expected 1')
    return cohorts[0]


def material_for(cohort: str) -> list:
    return [{'kind': 'COURSE', 'courseType': 'STUDY', 'courseId': course_id(cohort)}]


def cohort_order(requirement: dict) -> int:
    return int(re.match(r'\d+', requirement_cohort(requirement)).group(0))


def requirement_key(requirement: dict) -> dict:
    """The table is keyed on status and id."""
    return {'status': requirement['status'], 'id': requirement['id']}


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


def course_exists(table, course_id: str) -> bool:
    res = table.get_item(
        Key={'type': 'STUDY', 'id': course_id},
        ProjectionExpression='#id',
        ExpressionAttributeNames={'#id': 'id'},
    )
    return 'Item' in res


def plan_rows(rows: list, courses) -> list:
    """Returns (requirement, cohort, material) for every row whose material must change."""
    planned = []
    for row in rows:
        cohort = requirement_cohort(row)
        material = material_for(cohort)
        if row.get('material') == material:
            continue
        if not course_exists(courses, material[0]['courseId']):
            raise Exception(f'Course STUDY/{material[0]["courseId"]} does not exist; run import_study_courses.py first')
        planned.append((row, cohort, material))
    return planned


def diff_rows(dev_rows: list, prod) -> None:
    for row in dev_rows:
        res = prod.get_item(Key=requirement_key(row))
        prod_row = res.get('Item')
        cohort = requirement_cohort(row)
        if prod_row is None:
            print(f'{row["id"]} {cohort}: missing in prod')
            continue
        keys = sorted(set(row) | set(prod_row))
        changed = [key for key in keys if row.get(key) != prod_row.get(key)]
        print(f'{row["id"]} {cohort}: {", ".join(changed) if changed else "identical"}')


def main():
    args = parser.parse_args()
    db = boto3.resource('dynamodb')
    requirements = db.Table(args.requirements_table)
    courses = db.Table(args.courses_table)

    rows = sorted(list_requirements(requirements), key=cohort_order)
    print(f'Got {len(rows)} {REQUIREMENT_NAME} requirements')

    if args.diff:
        diff_rows(rows, db.Table(args.prod_requirements_table))
        return

    try:
        planned = plan_rows(rows, courses)
    except Exception as e:
        print(e)
        sys.exit(1)
    for row, cohort, material in planned:
        print(f'{row["id"]} {cohort:10} -> {material[0]["courseId"]}')
    print(f'{len(planned)} planned, {len(rows) - len(planned)} already set')

    if not args.apply:
        if planned:
            print('Dry run. Pass --apply to write.')
        return

    updated_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    updated = 0
    for row, _, material in planned:
        requirements.update_item(
            Key=requirement_key(row),
            UpdateExpression='SET material = :material, updatedAt = :updatedAt',
            ConditionExpression='attribute_exists(id)',
            ExpressionAttributeValues={':material': material, ':updatedAt': updated_at},
        )
        updated += 1
    print(f'Updated: {updated}')


if __name__ == '__main__':
    main()
