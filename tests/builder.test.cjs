const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../frontend/builder-core.js');
function section(id) {return {id,kind:'text',title:id,purpose:'Purpose',notes:'Source',text:'Approved wording',caption:'',figure_description:'',font_size:28,approved:true,rect:{x:.02,y:.2,w:.3,h:.3},sources:[]};}
test('switching layouts preserves approved content and never overlaps default regions',()=>{
    const input=[section('a'),section('b'),section('c'),section('d'),section('e')];
    for(const name of Object.keys(C.TEMPLATES)){
        const arranged=C.arrange(input,name);
        assert.deepEqual(arranged.map(s=>[s.text,s.approved]),input.map(s=>[s.text,s.approved]));
        const d={...C.createDocument(),title:'Study',authors:'Author',affiliations:'University',sections:arranged};
        assert.equal(C.warnings(d).length,0);
    }
});
test('drag and resize clamp content within poster body',()=>{
    const r=C.clampRect({x:3,y:-4,w:2,h:.4});assert.ok(r.x+r.w<=1);assert.ok(r.y>=.17);assert.ok(r.y+r.h<=1);
});
test('import rejects remote or executable figure sources and duplicate section IDs',()=>{
    const d={...C.createDocument(),sections:[{...section('a'),kind:'figure',imageData:'https://example.com/private.png'}]};
    assert.throws(()=>C.validateImport(d),/embedded PNG/);
    d.sections=[section('a'),section('a')];assert.throws(()=>C.validateImport(d),/invalid/);
});
test('saved draft retains source notes, geometry and approvals',()=>{
    const d={...C.createDocument(),sections:[section('a')]};const copy=C.validateImport(JSON.parse(JSON.stringify(d)));
    assert.equal(copy.sections[0].text,'Approved wording');assert.equal(copy.sections[0].approved,true);assert.equal(copy.sections[0].notes,'Source');assert.equal(copy.sections[0].rect.w,.3);
});
test('warnings distinguish unapproved content and overlapping approved regions',()=>{
    const d={...C.createDocument(),title:'Title',authors:'Names',affiliations:'University',sections:[section('a'),section('b')]};
    assert.match(C.warnings(d).join(' '),/overlaps/);d.sections[1].approved=false;assert.match(C.warnings(d).join(' '),/not approved/);
});
function assertClear(sections) {
    for(let i=0;i<sections.length;i++)for(let j=i+1;j<sections.length;j++)
        assert.equal(C.intersects(sections[i].rect,sections[j].rect,0),false,`${sections[i].id} overlaps ${sections[j].id}`);
}
test('dropping into another section moves neighbors while retaining text and approval',()=>{
    const original=[{...section('a'),rect:{x:.05,y:.2,w:.2,h:.2}}, {...section('b'),rect:{x:.3,y:.2,w:.2,h:.2}}];
    const result=C.placeSection(original,'a',{x:.3,y:.2,w:.2,h:.2},'three');
    assert.equal(result.mode,'packed');assertClear(result.sections);
    assert.equal(result.sections[0].rect.x,.3);
    assert.deepEqual(result.sections.map(s=>[s.text,s.approved,s.font_size]),original.map(s=>[s.text,s.approved,s.font_size]));
});
test('crowded boards retain requested dimensions and warn about overlaps',()=>{
    const original=C.arrange(Array.from({length:20},(_,i)=>section(`s${i}`)),'three');
    const result=C.placeSection(original,'s4',{x:.02,y:.17,w:.95,h:.8},'three');
    assert.equal(result.mode,'crowded');assert.equal(result.sections.length,20);assert.equal(result.sections.find(s=>s.id==='s4').rect.w,.95);assert.match(C.warnings({...C.createDocument(),sections:result.sections}).join(' '),/overlaps/);
    assert.ok(result.sections.every(s=>s.text==='Approved wording'&&s.approved));
});
test('unapproved figure placeholders also cause overlap warnings',()=>{
    const original=[section('a'),{...section('b'),approved:false,kind:'figure'}];
    assert.match(C.warnings({...C.createDocument(),sections:original}).join(' '),/overlaps/);
});

test('figure title and image sizing preferences survive editable draft restoration',()=>{
    const d={...C.createDocument(),sections:[{...section('figure'),kind:'figure',show_title:true,image_sizing:'crop',figure_fitted:true,imageData:'data:image/png;base64,aGVsbG8='}]};
    const restored=C.validateImport(d).sections[0];
    assert.equal(restored.show_title,true);assert.equal(restored.image_sizing,'crop');assert.equal(restored.figure_fitted,true);
    delete d.sections[0].show_title;delete d.sections[0].image_sizing;
    const legacy=C.validateImport(d).sections[0];assert.equal(legacy.show_title,false);assert.equal(legacy.image_sizing,'proportional');
});

test('all five CTSI layouts preserve text, approval, and nonoverlapping panels',()=>{
    const input=Array.from({length:7},(_,i)=>section('ctsi-'+i));
    for(let n=1;n<=5;n++){
        const output=C.arrange(input,'ctsi-'+n);
        assert.equal(output.length,7);
        assertClear(output);
        assert.deepEqual(output.map(s=>s.text),input.map(s=>s.text));
        assert.ok(output.every(s=>s.approved));
    }
});
test('CTSI layouts safely reflow eight to twenty sections',()=>{
    for(let n=1;n<=5;n++)for(const count of [8,12,20]){
        const output=C.arrange(Array.from({length:count},(_,i)=>section('s'+i)),'ctsi-'+n);
        assert.equal(output.length,count);
        assertClear(output);
    }
});
test('legacy two and three column draft layouts remain valid',()=>{
    for(const name of ['two','three']){
        const draft={...C.createDocument(),template:name,sections:C.arrange([section('a'),section('b')],name)};
        assert.equal(C.validateImport(draft).template,name);
    }
});

test('full width banner retains width and neighboring dimensions',()=>{
 const input=[{...section('a'),rect:{x:.025,y:.2,w:.3,h:.1}},{...section('b'),rect:{x:.35,y:.2,w:.3,h:.2}}];
 const result=C.placeSection(input,'a',{x:.025,y:.2,w:.95,h:.1},'ctsi-1');
 assert.equal(result.mode,'packed');assertClear(result.sections);assert.equal(result.sections[0].rect.w,.95);assert.equal(result.sections[1].rect.w,.3);
});
test('project export names and custom short title survive import',()=>{
 const d={...C.createDocument(),title:'Proton versus photon radiotherapy',authors:'Steven J Frank 1, Paul Busse 2'};
 const date=new Date(2026,10,24);
 assert.equal(C.exportName(d,'draft',date),'Frank_Proton-vs-photon-radiotherapy_2026-11-24_Draft.json');
 d.short_title='Custom project';assert.equal(C.validateImport(d).short_title,'Custom project');
 assert.equal(C.exportName(d,'mockup',date),'Frank_Custom-project_2026-11-24_Mockup.png');
});
