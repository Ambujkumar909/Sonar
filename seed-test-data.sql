-- Seed: 1 session, 6 watch groups (2 COCO / 2 FOFO / 2 MBO), realistic messages in the last 24h.
-- Safe to re-run: deletes previous 'seed1' rows first.
DELETE FROM messages WHERE session_id='seed1';
DELETE FROM chats WHERE session_id='seed1';
DELETE FROM groups WHERE session_id='seed1';
DELETE FROM sessions WHERE id='seed1';

INSERT INTO sessions (id,name,status,phone,watch_all,created_at)
VALUES ('seed1','Seed Test Mobile','open','919999900000',0,(extract(epoch from now())*1000)::bigint);

-- helper: now in ms
CREATE TEMP TABLE _n AS SELECT (extract(epoch from now())*1000)::bigint AS ms;

INSERT INTO chats (session_id,jid,name,is_group,last_ts,watch_key) VALUES
('seed1','g1@g.us','COCO-DDECOR OWN STORE, MUMBAI 10009001',1,(SELECT ms FROM _n),'g1@g.us'),
('seed1','g2@g.us','COCO-DDECOR STORE, BANGALORE 10009002',1,(SELECT ms FROM _n),'g2@g.us'),
('seed1','g3@g.us','FOFO-DCA MARKETING, CHANDIGARH 10002716',1,(SELECT ms FROM _n),'g3@g.us'),
('seed1','g4@g.us','FOFO-ABACUS INDIA, LUCKNOW 10001841',1,(SELECT ms FROM _n),'g4@g.us'),
('seed1','g5@g.us','SHARMA FURNISHINGS, JAIPUR',1,(SELECT ms FROM _n),'g5@g.us'),
('seed1','g6@g.us','ROYAL HOME DECOR, INDORE',1,(SELECT ms FROM _n),'g6@g.us');

INSERT INTO groups (session_id,jid,subject,participants,created_at) VALUES
('seed1','g1@g.us','COCO-DDECOR OWN STORE, MUMBAI 10009001',8,(SELECT ms FROM _n)),
('seed1','g2@g.us','COCO-DDECOR STORE, BANGALORE 10009002',6,(SELECT ms FROM _n)),
('seed1','g3@g.us','FOFO-DCA MARKETING, CHANDIGARH 10002716',9,(SELECT ms FROM _n)),
('seed1','g4@g.us','FOFO-ABACUS INDIA, LUCKNOW 10001841',7,(SELECT ms FROM _n)),
('seed1','g5@g.us','SHARMA FURNISHINGS, JAIPUR',5,(SELECT ms FROM _n)),
('seed1','g6@g.us','ROYAL HOME DECOR, INDORE',6,(SELECT ms FROM _n));

INSERT INTO messages (msg_id,session_id,chat_jid,chat_name,is_group,sender_jid,sender_name,from_me,type,text,has_media,ts,created_at)
SELECT * FROM (VALUES
-- COCO Mumbai: stock missing + PO
('m01','seed1','g1@g.us','COCO-DDECOR OWN STORE, MUMBAI 10009001',1,'u1@s.wa','Rakesh (Store Mgr)',0,'text','Sir Nirvana book ka NIR-1104 fabric out of stock dikha raha hai portal pe, customer ready hai order dene ko',0,(SELECT ms-72000000 FROM _n),(SELECT ms FROM _n)),
('m02','seed1','g1@g.us','COCO-DDECOR OWN STORE, MUMBAI 10009001',1,NULL,NULL,1,'text','Checking with warehouse team, will confirm by evening',0,(SELECT ms-70000000 FROM _n),(SELECT ms FROM _n)),
('m03','seed1','g1@g.us','COCO-DDECOR OWN STORE, MUMBAI 10009001',1,'u1@s.wa','Rakesh (Store Mgr)',0,'text','PO 458821 raised for Sofa So Good collection, 45 mtr. Please expedite',0,(SELECT ms-40000000 FROM _n),(SELECT ms FROM _n)),
('m04','seed1','g1@g.us','COCO-DDECOR OWN STORE, MUMBAI 10009001',1,'u1@s.wa','Rakesh (Store Mgr)',0,'text','NIR-1104 abhi bhi not available since 2 weeks, customer cancel kar dega',0,(SELECT ms-20000000 FROM _n),(SELECT ms FROM _n)),
-- COCO Bangalore: dispatch delay
('m05','seed1','g2@g.us','COCO-DDECOR STORE, BANGALORE 10009002',1,'u2@s.wa','Priya (Store)',0,'text','Order 512240 dispatched nahi hua abhi tak? Customer festival se pehle chahiye bola tha',0,(SELECT ms-60000000 FROM _n),(SELECT ms FROM _n)),
('m06','seed1','g2@g.us','COCO-DDECOR STORE, BANGALORE 10009002',1,NULL,NULL,1,'text','Transporter issue tha, dispatch tomorrow morning confirmed',0,(SELECT ms-58000000 FROM _n),(SELECT ms FROM _n)),
('m07','seed1','g2@g.us','COCO-DDECOR STORE, BANGALORE 10009002',1,'u2@s.wa','Priya (Store)',0,'text','Very urgent please, already 6 days late. Bhejo aaj hi',0,(SELECT ms-30000000 FROM _n),(SELECT ms FROM _n)),
-- FOFO DCA: quality defect
('m08','seed1','g3@g.us','FOFO-DCA MARKETING, CHANDIGARH 10002716',1,'u3@s.wa','Amit DCA',0,'text','Received curtain lot 774412, 3 rolls me shade variation hai same lot ke andar. Photos bhej raha hu',0,(SELECT ms-65000000 FROM _n),(SELECT ms FROM _n)),
('m09','seed1','g3@g.us','FOFO-DCA MARKETING, CHANDIGARH 10002716',1,'u3@s.wa','Amit DCA',0,'text','',1,(SELECT ms-64000000 FROM _n),(SELECT ms FROM _n)),
('m10','seed1','g3@g.us','FOFO-DCA MARKETING, CHANDIGARH 10002716',1,NULL,NULL,1,'text','Noted, raising QC complaint. Replacement from same lot will be arranged',0,(SELECT ms-50000000 FROM _n),(SELECT ms FROM _n)),
('m11','seed1','g3@g.us','FOFO-DCA MARKETING, CHANDIGARH 10002716',1,'u3@s.wa','Amit DCA',0,'text','Return pickup kab hoga? Customer wapas aa raha hai Saturday ko',0,(SELECT ms-15000000 FROM _n),(SELECT ms FROM _n)),
-- FOFO Abacus: bulk project + discount
('m12','seed1','g4@g.us','FOFO-ABACUS INDIA, LUCKNOW 10001841',1,'u4@s.wa','Sanjay Abacus',0,'text','Hotel project enquiry — 500 mtr blackout fabric chahiye, Eclipse collection. Urgent quote bhejo',0,(SELECT ms-55000000 FROM _n),(SELECT ms FROM _n)),
('m13','seed1','g4@g.us','FOFO-ABACUS INDIA, LUCKNOW 10001841',1,NULL,NULL,1,'text','Sharing rate list today. Project discount applicable on 500+ mtr',0,(SELECT ms-52000000 FROM _n),(SELECT ms FROM _n)),
('m14','seed1','g4@g.us','FOFO-ABACUS INDIA, LUCKNOW 10001841',1,'u4@s.wa','Sanjay Abacus',0,'text','Client bol raha hai 12% discount de do to PO final kar denge aaj hi. Scheme pending hai kya?',0,(SELECT ms-18000000 FROM _n),(SELECT ms FROM _n)),
-- MBO Sharma: portal/QR issue
('m15','seed1','g5@g.us','SHARMA FURNISHINGS, JAIPUR',1,'u5@s.wa','Sharma ji',0,'text','QR scan fail ho raha hai naye price list ka, portal pe mapping error dikha raha hai',0,(SELECT ms-62000000 FROM _n),(SELECT ms FROM _n)),
('m16','seed1','g5@g.us','SHARMA FURNISHINGS, JAIPUR',1,NULL,NULL,1,'text','IT team ko forward kiya hai, aaj shaam tak fix ho jayega',0,(SELECT ms-45000000 FROM _n),(SELECT ms FROM _n)),
('m17','seed1','g5@g.us','SHARMA FURNISHINGS, JAIPUR',1,'u5@s.wa','Sharma ji',0,'text','Ledger statement bhi bhejo last quarter ka, 335601 invoice ka credit note pending hai',0,(SELECT ms-22000000 FROM _n),(SELECT ms FROM _n)),
-- MBO Royal: new collection + onboarding
('m18','seed1','g6@g.us','ROYAL HOME DECOR, INDORE',1,'u6@s.wa','Vikram Royal',0,'text','New Signature collection ka catalogue kab milega? Display ke liye jagah ready hai',0,(SELECT ms-48000000 FROM _n),(SELECT ms FROM _n)),
('m19','seed1','g6@g.us','ROYAL HOME DECOR, INDORE',1,NULL,NULL,1,'text','Catalogue dispatch ho gaya, tracking share kar raha hu. New dealer portal ID bhi ban gayi hai aapki',0,(SELECT ms-25000000 FROM _n),(SELECT ms FROM _n)),
('m20','seed1','g6@g.us','ROYAL HOME DECOR, INDORE',1,'u6@s.wa','Vikram Royal',0,'text','First PO 668910 daal diya portal se, 30 mtr upholstery. Confirm karo received hua ki nahi',0,(SELECT ms-10000000 FROM _n),(SELECT ms FROM _n))
) v;

SELECT chat_name, COUNT(*) FROM messages WHERE session_id='seed1' GROUP BY 1 ORDER BY 1;
