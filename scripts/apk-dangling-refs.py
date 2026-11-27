#!/usr/bin/env python3
"""Find calls in an APK to methods the APK does not contain.

    python3 scripts/apk-dangling-refs.py app.apk 'Landroidx/credentials/'
    -> app.apk: 5 dex, 40700 classes, 3401 references checked, 0 dangling

An Android library module is compiled against the dependency versions it
declares itself, and run against the versions the app packages. When those
differ, the module can be compiled to call a method that is not in the APK.
Nothing notices at build time. On the phone it is a NoSuchMethodError the first
time that line runs.

That is how builds 20 to 27 (2026-11-04 to 2026-11-11) shipped unable to create
a wallet: react-native-passkeys was compiled against androidx.credentials
1.3.0-alpha01 and the APK held 1.6.0, where the constructor of
CreatePublicKeyCredentialRequest has one more parameter. Signing in still
worked, so nobody who already had a wallet saw it.

This reads every classes*.dex in the APK and reports each method reference
that names a class the APK defines but a method neither that class nor any of
its ancestors in the APK has. The optional second argument limits the check to
classes whose descriptor starts with it. Needs nothing but Python.

Exit status: 0 nothing dangling, 1 something dangling, 2 nothing was checked
(wrong prefix, or not an APK). An empty check is not a pass.

Checked against builds 23, 26 and 27, which all report exactly the constructor
above and nothing else under 'Landroidx/credentials/'.
"""

import os
import struct
import sys
import zipfile

# Inherited from java.lang.Object, which lives in the platform, not the APK.
OBJECT_METHODS = {
    "hashCode", "equals", "toString", "getClass", "notify", "notifyAll",
    "wait", "clone", "finalize",
}


def uleb128(buf: bytes, offset: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = buf[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, offset
        shift += 7


def parse_dex(buf: bytes):
    """Return (method references, {class: (superclass, interfaces, defined methods)})."""
    (
        string_count, string_off, type_count, type_off, proto_count, proto_off,
        _field_count, _field_off, method_count, method_off, class_count, class_off,
    ) = struct.unpack_from("<12I", buf, 0x38)

    def string(index: int) -> str:
        (data_off,) = struct.unpack_from("<I", buf, string_off + 4 * index)
        _, start = uleb128(buf, data_off)
        return buf[start : buf.index(0, start)].decode("utf-8", "replace")

    types = [
        string(struct.unpack_from("<I", buf, type_off + 4 * i)[0]) for i in range(type_count)
    ]

    def type_list(offset: int) -> list[str]:
        if not offset:
            return []
        (count,) = struct.unpack_from("<I", buf, offset)
        return [types[i] for i in struct.unpack_from("<%dH" % count, buf, offset + 4)]

    protos = []
    for i in range(proto_count):
        _shorty, return_type, params_off = struct.unpack_from("<3I", buf, proto_off + 12 * i)
        protos.append("(" + "".join(type_list(params_off)) + ")" + types[return_type])

    methods = []
    for i in range(method_count):
        class_idx, proto_idx, name_idx = struct.unpack_from("<HHI", buf, method_off + 8 * i)
        methods.append((types[class_idx], string(name_idx), protos[proto_idx]))

    classes = {}
    for i in range(class_count):
        (
            class_idx, _access, super_idx, interfaces_off, _source, _annotations,
            data_off, _static_values,
        ) = struct.unpack_from("<8I", buf, class_off + 32 * i)
        defined = set()
        if data_off:
            offset = data_off
            static_fields, offset = uleb128(buf, offset)
            instance_fields, offset = uleb128(buf, offset)
            direct_methods, offset = uleb128(buf, offset)
            virtual_methods, offset = uleb128(buf, offset)
            for _ in range(static_fields + instance_fields):
                _, offset = uleb128(buf, offset)
                _, offset = uleb128(buf, offset)
            for count in (direct_methods, virtual_methods):
                index = 0
                for _ in range(count):
                    delta, offset = uleb128(buf, offset)
                    index += delta
                    _, offset = uleb128(buf, offset)  # access flags
                    _, offset = uleb128(buf, offset)  # code offset
                    defined.add(methods[index][1:])
        superclass = types[super_idx] if super_idx != 0xFFFFFFFF else None
        classes[types[class_idx]] = (superclass, type_list(interfaces_off), defined)

    return methods, classes


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: apk-dangling-refs.py <apk> [class-descriptor-prefix]", file=sys.stderr)
        return 2
    apk = sys.argv[1]
    prefix = sys.argv[2] if len(sys.argv) == 3 else ""

    references, classes, dex_count = set(), {}, 0
    with zipfile.ZipFile(apk) as archive:
        for name in archive.namelist():
            if name.startswith("classes") and name.endswith(".dex"):
                methods, defined = parse_dex(archive.read(name))
                references.update(methods)
                classes.update(defined)
                dex_count += 1

    def has(cls: str, signature: tuple[str, str], seen: set[str]):
        """True, False, or None when the ancestry leaves the APK and cannot be read."""
        if cls in seen:
            return False
        seen.add(cls)
        if cls not in classes:
            return None
        superclass, interfaces, defined = classes[cls]
        if signature in defined:
            return True
        # Constructors and static initialisers are never inherited.
        if signature[0] in ("<init>", "<clinit>"):
            return False
        if signature[0] in OBJECT_METHODS:
            return True
        unknown = False
        for parent in [superclass, *interfaces]:
            if parent is None:
                continue
            found = has(parent, signature, seen)
            if found:
                return True
            if found is None and parent != "Ljava/lang/Object;":
                unknown = True
        return None if unknown else False

    checked, dangling = 0, []
    for cls, name, proto in sorted(references):
        if not cls.startswith(prefix) or cls not in classes:
            continue
        checked += 1
        if has(cls, (name, proto), set()) is False:
            dangling.append((cls, name, proto))

    scope = " under %s" % prefix if prefix else ""
    print(
        "%s: %d dex, %d classes, %d references checked%s, %d dangling"
        % (os.path.basename(apk), dex_count, len(classes), checked, scope, len(dangling))
    )
    for cls, name, proto in dangling:
        print("  MISSING %s -> %s%s" % (cls, name, proto))
        for other_name, other_proto in sorted(classes[cls][2]):
            if other_name == name:
                print("      the APK has %s%s" % (other_name, other_proto))

    if checked == 0:
        print("Nothing was checked. That is not a pass.", file=sys.stderr)
        return 2
    return 1 if dangling else 0


if __name__ == "__main__":
    sys.exit(main())
