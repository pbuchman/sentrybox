"""Move legacy entries and seal files from runtime-writable staging areas."""

from contextlib import ExitStack, contextmanager
import os
from pathlib import Path
import stat
import sys
import tempfile

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
MAX_BACKUP_BYTES = 5 * 1024**3
MAX_CREDENTIAL_BYTES = 64 * 1024


@contextmanager
def open_directory(path):
    with ExitStack() as stack:
        directory = os.open("/", DIRECTORY)
        stack.callback(os.close, directory)
        for item in Path(path).parts[1:]:
            directory = os.open(item, DIRECTORY, dir_fd=directory)
            stack.callback(os.close, directory)
        yield directory


def move_entry(source, destination, owner, mode, is_directory=False):
    """Rename a verified inode on the same filesystem, without copying data."""
    with open_directory(source.parent) as parent, open_directory(destination.parent) as target:
        descriptor = os.open(
            source.name, DIRECTORY if is_directory else os.O_PATH | os.O_NOFOLLOW, dir_fd=parent
        )
        try:
            original = os.fstat(descriptor)
            if (
                (original.st_uid, original.st_gid) != owner
                or stat.S_IMODE(original.st_mode) != mode
                or (not is_directory and (not stat.S_ISREG(original.st_mode) or original.st_nlink != 1))
            ):
                raise ValueError("legacy entry metadata is invalid")
            if original.st_dev != os.fstat(target).st_dev:
                raise ValueError("legacy and runtime paths must use the same filesystem")
            os.rename(source.name, destination.name, src_dir_fd=parent, dst_dir_fd=target)
            moved = os.stat(destination.name, dir_fd=target, follow_symlinks=False)
            if (moved.st_dev, moved.st_ino) != (original.st_dev, original.st_ino):
                raise ValueError("legacy entry changed during migration")
            if is_directory and destination.name == "backups":
                os.fchown(descriptor, 0, 0)
            os.fsync(parent)
            os.fsync(target)
        finally:
            os.close(descriptor)


def copy_snapshot(source, destination, owner, max_bytes=MAX_BACKUP_BYTES):
    """Read only a bounded regular file and publish a fresh protected inode."""
    with open_directory(source.parent) as parent:
        descriptor = os.open(source.name, REGULAR, dir_fd=parent)
        with os.fdopen(descriptor, "rb") as snapshot:
            metadata = os.fstat(descriptor)
            if (
                (metadata.st_uid, metadata.st_gid) != owner
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_nlink != 1
                or not 0 < metadata.st_size <= max_bytes
            ):
                raise ValueError("snapshot metadata is invalid")
            path = None
            try:
                with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
                    path = output.name
                    remaining = metadata.st_size
                    while remaining:
                        chunk = snapshot.read(min(remaining, 1024**2))
                        if not chunk:
                            raise ValueError("snapshot size changed while sealing")
                        output.write(chunk)
                        remaining -= len(chunk)
                    if snapshot.read(1) or os.fstat(descriptor).st_ctime_ns != metadata.st_ctime_ns:
                        raise ValueError("snapshot changed while sealing")
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(path, destination)
                path = None
                with open_directory(destination.parent) as directory:
                    os.fsync(directory)
            finally:
                if path is not None:
                    os.unlink(path)


def read_credential(directory, name):
    descriptor = os.open(name, REGULAR, dir_fd=directory)
    with os.fdopen(descriptor, "rb") as credential:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
            or not 0 < metadata.st_size <= MAX_CREDENTIAL_BYTES
        ):
            raise ValueError("tunnel credential metadata is invalid")
        value = credential.read(MAX_CREDENTIAL_BYTES + 1)
        if len(value) != metadata.st_size:
            raise ValueError("tunnel credential changed during migration")
        return value


def reconcile_credential(source, destination, remove):
    """Keep the old token usable until the shared tunnel has its protected unit."""
    if not remove and not os.path.lexists(destination):
        copy_snapshot(source, destination, (0, 0), MAX_CREDENTIAL_BYTES)
        return
    with open_directory(source.parent) as parent, open_directory(destination.parent) as target:
        attributes = os.fstat(parent)
        if (attributes.st_uid, attributes.st_gid, stat.S_IMODE(attributes.st_mode)) != (0, 0, 0o700):
            raise ValueError("legacy tunnel credential directory is unsafe")
        if read_credential(parent, source.name) != read_credential(target, destination.name):
            raise ValueError("legacy and protected tunnel credentials differ")
        if remove:
            os.unlink(source.name, dir_fd=parent)
            os.fsync(parent)


def main():
    action, source, destination, uid, gid = sys.argv[1:]
    source, destination = Path(source), Path(destination)
    owner = (int(uid), int(gid))
    if action == "seal-backup":
        copy_snapshot(source, destination, owner)
    elif action in {"stage-credential", "retire-credential"}:
        reconcile_credential(source, destination, action == "retire-credential")
    elif action in {"move-file", "move-directory"}:
        move_entry(
            source,
            destination,
            owner,
            0o700 if action == "move-directory" else 0o600,
            action == "move-directory",
        )
    else:
        raise ValueError("unknown protected file operation")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        print("SentryBox protected file operation failed; check path metadata and filesystem.", file=sys.stderr)
        sys.exit(1)
