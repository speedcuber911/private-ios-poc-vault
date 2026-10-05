"""Offline checks for the idle auto-stop Lambda; AWS clients are mocked."""

import datetime
import importlib
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

NOW = datetime.datetime.now(datetime.timezone.utc)
LONG_AGO = NOW - datetime.timedelta(hours=5)


def instance(instance_id, name, launched=LONG_AGO, state="running", **tags):
    return {
        "InstanceId": instance_id,
        "State": {"Name": state},
        "LaunchTime": launched,
        "Tags": [{"Key": "Name", "Value": name}] + [{"Key": k, "Value": v} for k, v in tags.items()],
    }


def series(value, points=24):
    return {
        "Timestamps": [NOW - datetime.timedelta(minutes=5 * k) for k in range(points)],
        "Values": [value] * points,
    }


class IdleAutoStopTest(unittest.TestCase):
    def setUp(self):
        self.ec2 = mock.Mock()
        self.cw = mock.Mock()
        self.queried = []
        self.metrics = {}

        def get_metric_data(MetricDataQueries, StartTime, EndTime):
            ids = [q["Id"] for q in MetricDataQueries]
            self.queried.extend(ids)
            return {"MetricDataResults": [{"Id": i, **self.metrics.get(i, series(0.5))} for i in ids]}

        self.cw.get_metric_data.side_effect = get_metric_data
        fake_boto3 = types.ModuleType("boto3")
        fake_boto3.client = lambda name, region_name=None: self.ec2 if name == "ec2" else self.cw
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        with mock.patch.dict(sys.modules, {"boto3": fake_boto3}), \
                mock.patch.dict(os.environ, {"DRY_RUN": "true"}):
            sys.modules.pop("lambda_function", None)
            self.f = importlib.import_module("lambda_function")
        sys.path.pop(0)

    def run_with(self, *instances):
        self.ec2.describe_instances.return_value = {"Reservations": [{"Instances": list(instances)}]}
        return self.f.lambda_handler({}, None)["results"]

    def test_opted_out_machine_is_skipped_without_reading_metrics(self):
        results = self.run_with(instance("i-a", "pariksj-dev", AutoStopEnabled="false"),
                                instance("i-b", "komal-dev"))
        self.assertIn("auto-stop turned off", results[0])
        self.assertIn("WOULD STOP", results[1])
        self.assertTrue(all(q.endswith("1") for q in self.queried))

    def test_dry_run_never_stops(self):
        self.run_with(instance("i-a", "pariksj-dev"))
        self.ec2.stop_instances.assert_not_called()

    def test_live_run_stops_and_tags_an_idle_machine(self):
        self.f.DRY_RUN = False
        results = self.run_with(instance("i-a", "pariksj-dev", AutoStopEnabled="true"))
        self.assertIn("STOPPED", results[0])
        self.ec2.stop_instances.assert_called_once_with(InstanceIds=["i-a"])
        tags = {t["Key"] for t in self.ec2.create_tags.call_args.kwargs["Tags"]}
        self.assertEqual(tags, {"AutoStoppedAt", "AutoStopReason"})

    def test_one_busy_sample_keeps_the_machine_up(self):
        self.f.DRY_RUN = False
        busy = series(0.5)
        busy["Values"][3] = 40.0
        self.metrics["cpu0"] = busy
        self.assertIn("active", self.run_with(instance("i-a", "pariksj-dev"))[0])
        self.ec2.stop_instances.assert_not_called()

    def test_recent_start_and_thin_metrics_are_left_alone(self):
        self.f.DRY_RUN = False
        recent = instance("i-a", "pariksj-dev", launched=NOW - datetime.timedelta(minutes=30))
        self.assertIn("launched too recently", self.run_with(recent)[0])
        self.metrics["cpu0"] = series(0.5, points=5)
        self.assertIn("insufficient metric coverage", self.run_with(instance("i-a", "pariksj-dev"))[0])
        self.ec2.stop_instances.assert_not_called()


if __name__ == "__main__":
    unittest.main()
