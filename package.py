#!/usr/bin/env python3
"""Build the local extension package without downloading build tools."""
import json
import pathlib
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parent
package = json.loads((root / 'package.json').read_text())
destination = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else f'/tmp/change-review-{package["version"]}.vsix')
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}"/>
    <DisplayName>{package['displayName']}</DisplayName>
    <Description xml:space="preserve">{package['description']}</Description>
    <Icon>extension/{package['icon']}</Icon>
    <Tags>review</Tags><Categories>Other</Categories><GalleryFlags/>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{package['icon']}" Addressable="true"/>
  </Assets>
</PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/>
<Default Extension="js" ContentType="application/javascript"/>
<Default Extension="mjs" ContentType="application/javascript"/>
<Default Extension="css" ContentType="text/css"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="md" ContentType="text/markdown"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/>
<Default Extension="xml" ContentType="text/xml"/>
<Default Extension="" ContentType="text/plain"/>
</Types>'''
files = [root / name for name in ['package.json', 'package-lock.json', 'README.md', 'core.js', 'files.js', 'review.js', 'review-model.js', 'mode-status.js', 'bridge.js', 'install.py', 'install-native.py', 'review-native.mjs']]
files += [p for directory in ['media', 'node_modules/diff'] for p in (root / directory).rglob('*') if p.is_file()]
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', content_types)
    for file in files:
        entry = 'extension/' + file.relative_to(root).as_posix()
        if file == root / 'package.json':
            packaged = {**package, '__metadata': {'publisherDisplayName': package['author']['name']}}
            archive.writestr(entry, json.dumps(packaged, ensure_ascii=False, indent=2) + '\n')
        else:
            archive.write(file, entry)
print(destination)
